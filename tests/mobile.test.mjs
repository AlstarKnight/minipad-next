// Browser-level Android-shell regression tests. The native IPC boundary is mocked;
// Android CI additionally compiles the real Rust backend and signs the APK.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { serve } from "../scripts/serve.mjs";

let browser, server, url;
const root = fileURLToPath(new URL("../mobile-dist/", import.meta.url));
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nP7sAAAAASUVORK5CYII=",
  "base64",
);

before(async () => {
  server = await serve(root);
  url = `http://127.0.0.1:${server.address().port}/mobile.html`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
});

async function chooseNote(page, name) {
  await page.click("#open-drawer");
  await page.locator("#note-filter").fill("");
  await page.locator("#notes-list button").filter({ hasText: name }).click();
}

async function open() {
  const context = await browser.newContext({ viewport: { width: 390, height: 740 } });
  await context.addInitScript(() => {
    const disk = [
      { name: "", notes: [
        { name: "一", content: "# 标题\n\n第一段", unreadable: false },
        { name: "二", content: "第二页", unreadable: false },
      ] },
    ];
    const writes = [];
    const images = {};
    const calls = { list: 0, read: 0, readImage: 0 };
    window.__mobileTest = { disk, writes, images, calls, failSaves: 0, readDelay: 0, conflictNext: false };
    window.__TAURI__ = { core: {
      async invoke(command, args = {}) {
        const book = disk.find((b) => b.name === args.book) || disk[0];
        if (command === "mobile_list_books") {
          calls.list++;
          return disk.map((b) => ({ name: b.name, notes: b.notes.map((n) => n.name) }));
        }
        if (command === "mobile_read_note") {
          calls.read++;
          if (window.__mobileTest.readDelay) await new Promise((r) => setTimeout(r, window.__mobileTest.readDelay));
          const { content, unreadable } = book.notes.find((n) => n.name === args.name);
          return { content, unreadable, reason: null };
        }
        if (command === "mobile_save_note") {
          if (window.__mobileTest.failSaves-- > 0) throw new Error("disk full");
          const note = book.notes.find((n) => n.name === args.name);
          if (note.content !== args.expected) throw new Error("stale expected content");
          note.content = args.content;
          writes.push({ ...args });
          if (window.__mobileTest.conflictNext) {
            window.__mobileTest.conflictNext = false;
            book.notes.push({ name: args.name + " 冲突副本", content: "旧内容", unreadable: false });
            return { conflict_name: args.name + " 冲突副本" };
          }
          return { conflict_name: null };
        }
        if (command === "mobile_create_book") {
          disk.push({ name: args.name, notes: [] });
          return args.name;
        }
        if (command === "mobile_create_note") {
          book.notes.push({ name: args.name, content: "", unreadable: false });
          return args.name;
        }
        if (command === "mobile_save_image") {
          images["assets/test.png"] = "data:" + args.mime + ";base64," + args.data;
          return "assets/test.png";
        }
        if (command === "mobile_read_image") {
          calls.readImage++;
          return images[args.path] ?? Promise.reject("missing file");
        }
        throw new Error("Unknown command " + command);
      },
    } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url);
  try {
    await page.locator("#editor .ProseMirror h1").waitFor({ timeout: 3500 });
  } catch (error) {
    const status = await page.locator("#status").textContent();
    const snippet = await page.locator("#editor").innerHTML();
    throw new Error("Android editor did not initialize: " +
      JSON.stringify({ status, errors, snippet: snippet.slice(0, 500), reason: String(error) }));
  }
  return { context, page, errors };
}

test("mobile Milkdown renders notes, saves edits and switches pages", async () => {
  const { context, page, errors } = await open();
  try {
    assert.equal(await page.locator(".ProseMirror h1").textContent(), "标题");
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("追加");
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[0].content.includes("第一段追加"));
    assert.equal(await page.locator("#status").textContent(), "已保存");
    await chooseNote(page, "二");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    await chooseNote(page, "一");
    await page.locator(".ProseMirror p").filter({ hasText: "第一段追加" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("touch formatting and reading mode do not mutate the file", async () => {
  const { context, page, errors } = await open();
  try {
    await page.locator(".ProseMirror p").first().click();
    await page.click('#format-bar [data-cmd="block"]');
    await page.click('#ctx [data-act="h2"]');
    await page.locator(".ProseMirror h2").filter({ hasText: "第一段" }).waitFor();
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[0].content.includes("## 第一段"));
    const saved = await page.evaluate(() => window.__mobileTest.disk[0].notes[0].content);
    await page.click("#mode");
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "false");
    assert.equal(await page.locator("#mobile-dock").isVisible(), false);
    await page.click("#mode");
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "true");
    assert.equal(await page.evaluate(() => window.__mobileTest.disk[0].notes[0].content), saved);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("picker image is stored under assets and Markdown keeps a relative path", async () => {
  const { context, page, errors } = await open();
  try {
    await page.locator(".ProseMirror p").first().click();
    await page.locator("#image-file").setInputFiles({
      name: "example.png", mimeType: "image/png", buffer: TINY_PNG,
    });
    await page.locator(".ProseMirror img:not(.ProseMirror-separator)").waitFor({ timeout: 10000 });
    await page.waitForFunction(() =>
      window.__mobileTest.disk[0].notes[0].content.includes("assets/test.png"));
    const content = await page.evaluate(() => window.__mobileTest.disk[0].notes[0].content);
    assert.match(content, /!\[example\]\(assets\/test\.png\)/);
    assert.equal(await page.locator(".ProseMirror img:not(.ProseMirror-separator)").getAttribute("src"),
      "data:image/png;base64," + TINY_PNG.toString("base64"));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("desktop code titles and fold blocks use the shared rich editor without metadata loss", async () => {
  const { context, page, errors } = await open();
  try {
    const content = "> [!fold]- 标题\n>\n> 内容\n\n```python 描述\nprint(1)\n```";
    await page.evaluate((content) => window.__mobileTest.disk[0].notes.push({
      name: "扩展语法", content, unreadable: false,
    }), content);
    await page.click("#refresh");
    await chooseNote(page, "扩展语法");
    try {
      await page.locator(".ProseMirror .fold-block").waitFor({ timeout: 2500 });
    } catch {
      const state = await page.evaluate(() => ({
        html: document.querySelector("#editor")?.innerHTML.slice(0, 3500),
        source: document.getElementById("source")?.value,
        sourceVisible: !document.getElementById("source")?.hidden,
        savedContent: window.__mobileTest.disk[0].notes[2].content,
        status: document.getElementById("status")?.textContent,
      }));
      throw new Error("Fold block missing: " + JSON.stringify(state));
    }
    await page.locator(".codeblock .cb-title").waitFor();
    assert.equal(await page.locator("#source").isVisible(), false);
    assert.equal(await page.locator(".codeblock .cb-title").inputValue(), "描述");
    assert.equal(await page.locator(".codeblock .cb-lang").inputValue(), "python");
    const before = await page.evaluate(() => window.__mobileTest.disk[0].notes[2].content);
    await page.click("#mode");
    await page.click("#mode");
    assert.equal(await page.evaluate(() => window.__mobileTest.disk[0].notes[2].content), before);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("unknown HTML keeps the lossless Markdown source fallback", async () => {
  const { context, page, errors } = await open();
  try {
    const content = "<div class='custom'>自定义 HTML</div>";
    await page.evaluate((content) => window.__mobileTest.disk[0].notes.push({
      name: "自定义语法", content, unreadable: false,
    }), content);
    await page.click("#refresh");
    await chooseNote(page, "自定义语法");
    await page.locator("#source").waitFor({ state: "visible" });
    assert.equal(await page.locator("#source").inputValue(), content);
    await page.locator("#source").fill(content + "\n新的说明");
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[2].content.endsWith("新的说明"));
    assert.equal(await page.evaluate(() => window.__mobileTest.disk[0].notes[2].content), content + "\n新的说明");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("touch drawer navigates notes without covering the editor permanently", async () => {
  const { context, page, errors } = await open();
  try {
    await page.click("#open-drawer");
    assert.equal(await page.locator("#mobile-drawer").isVisible(), true);
    await page.locator("#note-filter").fill("二");
    await page.locator('#notes-list button').filter({hasText:"二"}).click();
    await page.locator(".ProseMirror p").filter({hasText:"第二页"}).waitFor();
    assert.equal(await page.locator("#mobile-drawer").isVisible(), false);
    assert.equal(await page.locator("#page-title").textContent(), "二");
    assert.equal(await page.locator('#format-bar [data-cmd="codeblock"]').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("switching pages lists names and reads only the opened page", async () => {
  const { context, page, errors } = await open();
  try {
    const before = await page.evaluate(() => ({ ...window.__mobileTest.calls }));
    assert.equal(before.read, 1, "startup reads only the first page");
    await chooseNote(page, "二");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    const after = await page.evaluate(() => ({ ...window.__mobileTest.calls }));
    assert.equal(after.read, 2);
    assert.equal(after.list, before.list + 1);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("HTML tags inside code stay in the rich editor, real HTML still falls back to source", async () => {
  const { context, page, errors } = await open();
  try {
    const content = "```prompt\n<example type=\"good\">x</example>\n```\n\n行内 `<br>` 和\n\n~~~\n<div>\n~~~";
    await page.evaluate((content) => window.__mobileTest.disk[0].notes.push({
      name: "代码里的标签", content, unreadable: false,
    }), content);
    await page.click("#refresh");
    await chooseNote(page, "代码里的标签");
    await page.locator(".ProseMirror .codeblock").first().waitFor();
    assert.equal(await page.locator("#source").isVisible(), false);
    const mixed = content + "\n\n<div>真的 HTML</div>";
    await page.evaluate((mixed) => window.__mobileTest.disk[0].notes.push({
      name: "混合", content: mixed, unreadable: false,
    }), mixed);
    await page.click("#refresh");
    await chooseNote(page, "混合");
    await page.locator("#source").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a failed autosave is retried without another edit", async () => {
  const { context, page, errors } = await open();
  try {
    await page.evaluate(() => { window.__mobileTest.failSaves = 1; });
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("重试");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("保存失败"));
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[0].content.includes("第一段重试"),
      null, { timeout: 9000 });
    assert.equal(await page.locator("#status").textContent(), "已保存");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("inserted images are cached and not read back over IPC", async () => {
  const { context, page, errors } = await open();
  try {
    await page.locator(".ProseMirror p").first().click();
    await page.locator("#image-file").setInputFiles({
      name: "example.png", mimeType: "image/png", buffer: TINY_PNG,
    });
    await page.locator(".ProseMirror img:not(.ProseMirror-separator)").waitFor({ timeout: 10000 });
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[0].content.includes("assets/test.png"));
    await chooseNote(page, "二");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    await chooseNote(page, "一");
    await page.locator(".ProseMirror img:not(.ProseMirror-separator)").waitFor();
    assert.equal(await page.evaluate(() => window.__mobileTest.calls.readImage), 0);
    assert.equal(await page.locator(".ProseMirror img:not(.ProseMirror-separator)").getAttribute("src"),
      "data:image/png;base64," + TINY_PNG.toString("base64"));
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a new notebook gets its own first page and shows an empty editor", async () => {
  const { context, page, errors } = await open();
  try {
    const answers = ["工作", "第一页"];
    page.on("dialog", (dialog) => { void dialog.accept(answers.shift()); });
    await page.click("#open-drawer");
    await page.click("#add-book");
    await page.waitForFunction(() => document.getElementById("book-title").textContent.startsWith("工作"));
    await page.waitForFunction(() => document.querySelector("#editor .ProseMirror")?.textContent === "");
    assert.equal(await page.locator("#page-title").textContent(), "空笔记本");
    assert.match(await page.locator("#hint").textContent(), /新建/);
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "false");
    await page.click("#add-note");
    await page.waitForFunction(() => document.getElementById("page-title").textContent === "第一页");
    const disk = await page.evaluate(() => window.__mobileTest.disk.map((b) => [b.name, b.notes.map((n) => n.name)]));
    assert.deepEqual(disk, [["", ["一", "二"]], ["工作", ["第一页"]]]);
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "true");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the old page is read-only while another page loads", async () => {
  const { context, page, errors } = await open();
  try {
    await page.evaluate(() => { window.__mobileTest.readDelay = 600; });
    await page.click("#open-drawer");
    await page.locator("#notes-list button").filter({ hasText: "二" }).click();
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "false");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "true");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("switching pages right after a failed save keeps the edit and retries it", async () => {
  const { context, page, errors } = await open();
  try {
    await page.evaluate(() => { window.__mobileTest.failSaves = 1; });
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("别丢");
    await chooseNote(page, "二");
    await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("无法切换"));
    assert.equal(await page.locator("#page-title").textContent(), "一");
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[0].content.includes("第一段别丢"),
      null, { timeout: 9000 });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("Markdown autolinks stay in the rich editor", async () => {
  const { context, page, errors } = await open();
  try {
    await page.evaluate(() => window.__mobileTest.disk[0].notes.push({
      name: "链接", content: "见 <https://example.com> 或 <me@example.com>", unreadable: false,
    }));
    await page.click("#refresh");
    await chooseNote(page, "链接");
    await page.locator(".ProseMirror p").filter({ hasText: "见" }).waitFor();
    assert.equal(await page.locator("#source").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a conflict copy shows up in the page list right away", async () => {
  const { context, page, errors } = await open();
  try {
    await page.evaluate(() => { window.__mobileTest.conflictNext = true; });
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("改动");
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("冲突副本"));
    await page.click("#open-drawer");
    await page.locator("#notes-list button").filter({ hasText: "一 冲突副本" }).waitFor();
    assert.equal(await page.locator("#page-title").textContent(), "一");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("tapping the notebook already on screen keeps the open page", async () => {
  const { context, page, errors } = await open();
  try {
    await chooseNote(page, "二");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    await page.click("#open-drawer");
    await page.locator("#books-list button.active").click();
    await page.locator("#mobile-drawer").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#page-title").textContent(), "二");
    assert.equal(await page.evaluate(() => window.__mobileTest.calls.read), 2);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the toolbar stays visible while another page loads", async () => {
  const { context, page, errors } = await open();
  try {
    await page.evaluate(() => {
      window.__mobileTest.readDelay = 600;
      window.__toolbarHidden = [];
      new MutationObserver(() => window.__toolbarHidden.push(document.getElementById("mobile-dock").hidden))
        .observe(document.getElementById("mobile-dock"), { attributes: true, attributeFilter: ["hidden"] });
    });
    await chooseNote(page, "二");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__toolbarHidden), []);
    assert.equal(await page.evaluate(() => document.getElementById("mobile-dock").hidden), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a notebook created while a page is loading is still opened", async () => {
  const { context, page, errors } = await open();
  try {
    page.on("dialog", (dialog) => { void dialog.accept("新书"); });
    await page.evaluate(() => { window.__mobileTest.readDelay = 600; });
    await page.click("#open-drawer");
    await page.locator("#notes-list button").filter({ hasText: "二" }).click();
    await page.click("#add-book");
    await page.waitForFunction(() => document.getElementById("book-title").textContent.startsWith("新书"),
      null, { timeout: 8000 });
    assert.equal(await page.locator("#page-title").textContent(), "空笔记本");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
