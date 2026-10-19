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

// look: the saved appearance (0.4.4). Older tests were written for the original look, so they get "classic".
async function open({ colorScheme, keyboard, look = { ui: "classic" } } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 740 }, colorScheme });
  if (look) await context.addInitScript((v) => { if (!localStorage.getItem("minipad-mobile-look")) localStorage.setItem("minipad-mobile-look", v); }, JSON.stringify(look));
  if (keyboard) {
    // Android WebViews can shrink only the visual viewport when the soft keyboard opens.
    await context.addInitScript(() => {
      const fake = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
    });
  }
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
        if (command === "mobile_webdav_status") return { state: "synced", message: "已同步（测试）", history: [] };
        if (command === "mobile_webdav_set_password") {
          window.__mobileTest.savedWebdavPassword = args.password;
          return null;
        }
        if (command === "mobile_webdav_test") {
          if (!args.config.server) throw new Error("地址不能为空");
          return "连接测试成功";
        }
        if (command === "mobile_webdav_sync_now") {
          window.__mobileTest.syncCalls = (window.__mobileTest.syncCalls || 0) + 1;
          if (window.__mobileTest.syncDelay) await new Promise(r => setTimeout(r, window.__mobileTest.syncDelay));
          window.__mobileTest.lastSync = args;
          return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, changed: [] };
        }
        if (command === "mobile_webdav_forget") {
          window.__mobileTest.savedWebdavPassword = null;
          return null;
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

test("a refresh requested during a page switch does not switch back to the old page", async () => {
  const { context, page, errors } = await open();
  try {
    await page.evaluate(() => { window.__mobileTest.readDelay = 500; });
    await chooseNote(page, "二");
    await page.evaluate(() => document.getElementById("refresh").click());
    // The queued refresh starts its read after the first switch, then takes readDelay to finish.
    await page.waitForFunction(() => window.__mobileTest.calls.read === 3, null, { timeout: 8000 });
    await page.waitForFunction(() => document.getElementById("mobile-drawer").hidden, null, { timeout: 8000 });
    await page.waitForTimeout(900);
    assert.equal(await page.locator("#page-title").textContent(), "二");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("dark mode themes the block menu and the shared bars", async () => {
  const { context, page, errors } = await open({ colorScheme: "dark" });
  try {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    await page.locator(".ProseMirror p").first().click();
    await page.click("#block-actions");
    await page.locator("#ctx").waitFor({ state: "visible" });
    const [r, g, b] = (await page.evaluate(() => getComputedStyle(document.getElementById("ctx")).backgroundColor))
      .match(/\d+/g).map(Number);
    assert.ok((r + g + b) / 3 < 90, `block menu should be dark, got rgb(${r}, ${g}, ${b})`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("light mode keeps the light block menu", async () => {
  const { context, page, errors } = await open({ colorScheme: "light" });
  try {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    await page.locator(".ProseMirror p").first().click();
    await page.click("#block-actions");
    await page.locator("#ctx").waitFor({ state: "visible" });
    const [r, g, b] = (await page.evaluate(() => getComputedStyle(document.getElementById("ctx")).backgroundColor))
      .match(/\d+/g).map(Number);
    assert.ok((r + g + b) / 3 > 200, `block menu should be light, got rgb(${r}, ${g}, ${b})`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the toolbar stays above the soft keyboard", async () => {
  const { context, page, errors } = await open({ keyboard: true });
  try {
    const layout = () => page.evaluate(() => ({
      body: document.body.getBoundingClientRect().height,
      dockBottom: document.getElementById("mobile-dock").getBoundingClientRect().bottom,
      footerShown: getComputedStyle(document.querySelector(".bottom-status")).display !== "none",
      keyboard: document.documentElement.hasAttribute("data-keyboard"),
    }));
    const closed = await layout();
    assert.equal(closed.keyboard, false);
    assert.equal(closed.footerShown, true);
    await page.evaluate(() => {
      window.visualViewport.height = innerHeight - 300;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    const open = await layout();
    assert.equal(open.keyboard, true);
    assert.equal(open.footerShown, false);
    assert.equal(open.body, 740 - 300);
    assert.ok(open.dockBottom <= 740 - 300, `dock bottom ${open.dockBottom} is under the keyboard`);
    await page.evaluate(() => {
      window.visualViewport.height = innerHeight;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    const after = await layout();
    assert.equal(after.keyboard, false);
    assert.equal(after.body, 740);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("selecting text shows a floating format bar below the selection and it formats", async () => {
  const { context, page, errors } = await open();
  try {
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await page.locator("#toolbar").waitFor({ state: "visible" });
    const geometry = await page.evaluate(() => {
      const bar = document.getElementById("toolbar").getBoundingClientRect();
      const p = document.querySelector(".ProseMirror p").getBoundingClientRect();
      return { barTop: bar.top, paragraphBottom: p.bottom, barWidth: bar.width };
    });
    assert.ok(geometry.barTop >= geometry.paragraphBottom - 4, "the bar sits below the selected line");
    assert.ok(geometry.barWidth <= 390, "the bar fits the screen width");
    const size = await page.locator('#toolbar [data-cmd="strong"]').boundingBox();
    assert.ok(size.width >= 40 && size.height >= 40, "buttons are finger-sized");
    await page.click('#toolbar [data-cmd="strong"]');
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[0].content.includes("**第一段**"));
    // Collapsing the selection hides the bar again.
    await page.keyboard.press("ArrowRight");
    await page.locator("#toolbar").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("pinch-zooming is not mistaken for the soft keyboard", async () => {
  const { context, page, errors } = await open({ keyboard: true });
  try {
    await page.evaluate(() => {
      Object.assign(window.visualViewport, { scale: 2, width: innerWidth / 2, height: innerHeight / 2 });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    const zoomed = await page.evaluate(() => ({
      body: document.body.getBoundingClientRect().height,
      keyboard: document.documentElement.hasAttribute("data-keyboard"),
    }));
    assert.equal(zoomed.keyboard, false);
    assert.equal(zoomed.body, 740);
    // Zoomed 2x with a 300px keyboard and the view panned 50px: offsetTop is not scaled.
    const inset = await page.evaluate(() => {
      Object.assign(window.visualViewport, { height: (innerHeight - 300) / 2, offsetTop: 50 });
      window.visualViewport.dispatchEvent(new Event("resize"));
      return document.documentElement.style.getPropertyValue("--keyboard-inset");
    });
    assert.equal(inset, "250px");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

// ---------- 0.4.4 interface styles ----------
const shown = (page, selector) => page.locator(selector).first().evaluate((e) => getComputedStyle(e).display !== "none" && !e.closest("[hidden]"));
const rootAttr = (page, name) => page.evaluate((n) => document.documentElement.getAttribute(n), name);

test("a fresh install is starry: reading | editing segment and the categorized toolbar", async () => {
  const { context, page, errors } = await open({ look: null });
  try {
    assert.equal(await rootAttr(page, "data-ui"), "starry");
    assert.equal(await shown(page, "#mode"), false, "the single mode button gives way to the segment");
    const pressed = () => page.$$eval("#mode-seg button", (bs) => bs.map((b) => b.dataset.mode + ":" + b.getAttribute("aria-pressed")));
    assert.deepEqual(await pressed(), ["read:false", "edit:true"]);
    assert.equal(await shown(page, '#format-bar [data-cmd="strong"]'), true);
    assert.equal(await shown(page, '#format-bar [data-cmd="list"]'), false, "lists live under 段落");
    await page.click('#dock-cats [data-cat="para"]');
    assert.equal(await shown(page, '#format-bar [data-cmd="list"]'), true);
    assert.equal(await shown(page, '#format-bar [data-cmd="strong"]'), false);
    await page.click('#dock-cats [data-cat="color"]');
    assert.deepEqual(await page.$$eval("#format-bar [data-cmd]", (bs) => bs.filter((b) => getComputedStyle(b).display !== "none").map((b) => b.dataset.cmd)), ["color", "bg"]);
    await page.click('#mode-seg [data-mode="read"]');
    assert.deepEqual(await pressed(), ["read:true", "edit:false"]);
    assert.equal(await page.locator("#mobile-dock").isHidden(), true, "reading hides the toolbar");
    // tapping the side already chosen changes nothing
    await page.click('#mode-seg [data-mode="read"]');
    assert.deepEqual(await pressed(), ["read:true", "edit:false"]);
    await page.click('#mode-seg [data-mode="edit"]');
    assert.deepEqual(await pressed(), ["read:false", "edit:true"]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("appearance settings switch style, light/dark and accent at once and are remembered", async () => {
  const { context, page, errors } = await open({ look: null, colorScheme: "light" });
  try {
    await page.click("#open-drawer");
    await page.click("#open-settings");
    assert.equal(await page.locator("#mobile-drawer").isHidden(), true, "the drawer makes way for the sheet");
    const checked = () => page.$$eval("#ui-styles [aria-checked=true]", (bs) => bs.map((b) => b.dataset.ui));
    assert.deepEqual(await checked(), ["starry"]);
    assert.equal(await page.locator("#look-stars").isVisible(), true, "starry shows its own switches");
    await page.click('#ui-styles [data-ui="material"]');
    assert.equal(await rootAttr(page, "data-ui"), "material");
    assert.equal(await page.locator("#look-stars").isVisible(), false);
    await page.click('#look-theme [data-theme-choice="dark"]');
    assert.equal(await rootAttr(page, "data-theme"), "dark", "dark even though the phone is light");
    const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    assert.equal(await accent(), "#c3c0ff", "the Material dark primary");
    await page.click('#look-accent [data-color="#16a34a"]');
    assert.equal(await accent(), "#16a34a");
    assert.deepEqual(await page.$$eval("#look-accent [aria-checked=true]", (bs) => bs.map((b) => b.dataset.color)), ["#16a34a"]);
    await page.click('#ui-styles [data-ui="classic"]');
    assert.equal(await rootAttr(page, "data-ui"), null, "classic has no style attribute");
    assert.equal(await accent(), "#16a34a", "the picked accent survives a style change");
    await page.click('#look-accent [data-color=""]');
    assert.equal(await accent(), "#b6d1b8", "follow the style: the original dark green");
    await page.click('#look-theme [data-theme-choice="system"]');
    assert.equal(await rootAttr(page, "data-theme"), "light");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#mobile-settings").isHidden(), true);
    await page.click('#open-drawer');
    await page.click("#open-settings");
    await page.click('#ui-styles [data-ui="starry"]');
    await page.uncheck("#look-stars");
    await page.reload();
    await page.locator("#editor .ProseMirror h1").waitFor();
    assert.equal(await rootAttr(page, "data-ui"), "starry", "remembered after a restart");
    assert.equal(await rootAttr(page, "data-stars"), null);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("paper: the drawer is an outline tree and keeps the drawer open while changing notebooks", async () => {
  const { context, page, errors } = await open({ look: { ui: "paper" } });
  try {
    await page.evaluate(() => window.__mobileTest.disk.push({ name: "工作", notes: [{ name: "周报", content: "# 周报", unreadable: false }] }));
    await page.click("#refresh");
    await page.click("#open-drawer");
    const rows = () => page.$$eval("#notes-list button", (bs) => bs.map((b) => b.className + ":" + b.textContent));
    await page.waitForFunction(() => document.querySelectorAll("#notes-list .tree-book").length === 2);
    assert.deepEqual(await rows(), ["tree-book open:默认笔记本", "tree-page active:一", "tree-page:二", "tree-book:工作"]);
    assert.equal(await page.locator("#pages-heading").textContent(), "目录");
    await page.locator("#notes-list .tree-book").filter({ hasText: "工作" }).click();
    await page.waitForFunction(() => document.getElementById("page-title").textContent === "周报");
    assert.equal(await page.locator("#mobile-drawer").isHidden(), false, "the drawer stays to pick a page");
    assert.deepEqual(await rows(), ["tree-book:默认笔记本", "tree-book open:工作", "tree-page active:周报"]);
    await page.locator("#notes-list .tree-book").filter({ hasText: "默认笔记本" }).click();
    await page.waitForFunction(() => document.getElementById("page-title").textContent === "一");
    await page.locator("#notes-list .tree-page").filter({ hasText: "二" }).click();
    await page.waitForFunction(() => document.getElementById("page-title").textContent === "二");
    assert.equal(await page.locator("#mobile-drawer").isHidden(), true, "picking a page closes the drawer");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the hide-keyboard button shows while the keyboard is up and takes the focus away", async () => {
  const { context, page, errors } = await open({ keyboard: true, look: null });
  try {
    await page.locator(".ProseMirror p").first().click();
    assert.equal(await page.locator("#hide-keyboard").isVisible(), false);
    await page.evaluate(() => {
      window.visualViewport.height = innerHeight - 300;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    await page.click("#hide-keyboard");
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror")), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("a WebView that resizes the page for the keyboard and also shrinks the visual viewport leaves no gap", async () => {
  const { context, page, errors } = await open({ keyboard: true });
  try {
    // The page itself got 300px shorter, and the visual viewport reports another 300px on top.
    await page.setViewportSize({ width: 390, height: 440 });
    await page.evaluate(() => {
      window.visualViewport.height = innerHeight - 300;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    const layout = await page.evaluate(() => ({
      body: document.body.getBoundingClientRect().height,
      dockBottom: Math.ceil(document.getElementById("mobile-dock").getBoundingClientRect().bottom),
      keyboard: document.documentElement.hasAttribute("data-keyboard"),
      inset: document.documentElement.style.getPropertyValue("--keyboard-inset"),
    }));
    const { dockBottom, ...rest } = layout;
    assert.deepEqual(rest, { body: 440, keyboard: true, inset: "0px" });
    assert.ok(dockBottom >= 436 && dockBottom <= 440, `the toolbar ends at the keyboard (${dockBottom})`);
    await page.setViewportSize({ width: 390, height: 740 });
    await page.evaluate(() => {
      window.visualViewport.height = innerHeight;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    assert.equal(await rootAttr(page, "data-keyboard"), null);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("the floating new-page button creates a page, steps aside for the keyboard and can be turned off", async () => {
  for (const ui of ["starry", "material", "paper", "classic"]) {
    const { context, page, errors } = await open({ keyboard: true, look: { ui } });
    try {
      page.on("dialog", (dialog) => { void dialog.accept("三"); });
      const fab = page.locator("#new-page");
      await fab.waitFor({ state: "visible" });
      const box = await fab.boundingBox();
      const dockTop = await page.locator("#mobile-dock").evaluate((d) => d.getBoundingClientRect().top);
      assert.ok(box.y + box.height <= dockTop - 8, `${ui}: the button sits above the toolbar`);
      assert.ok(box.width >= 44 && box.height >= 44, `${ui}: finger-sized`);
      await fab.click();
      await page.waitForFunction(() => document.getElementById("page-title").textContent === "三");
      assert.deepEqual(await page.evaluate(() => window.__mobileTest.disk[0].notes.map((n) => n.name)), ["一", "二", "三"]);
      await page.evaluate(() => {
        window.visualViewport.height = innerHeight - 300;
        window.visualViewport.dispatchEvent(new Event("resize"));
      });
      assert.equal(await fab.isVisible(), false, `${ui}: hidden while typing`);
      await page.evaluate(() => {
        window.visualViewport.height = innerHeight;
        window.visualViewport.dispatchEvent(new Event("resize"));
      });
      await fab.waitFor({ state: "visible" });
      await page.click("#open-drawer");
      await page.click("#open-settings");
      await page.uncheck("#look-fab");
      await page.click("#close-settings");
      assert.equal(await fab.isVisible(), false, `${ui}: turned off`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test("when the WebView pans the visual viewport down for the keyboard, the page follows it", async () => {
  const { context, page, errors } = await open({ keyboard: true });
  try {
    // Only the visual viewport shrank, and it was scrolled down 300px to show the caret.
    await page.evaluate(() => {
      Object.assign(window.visualViewport, { height: innerHeight - 300, offsetTop: 300 });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    const layout = () => page.evaluate(() => ({
      top: Math.round(document.body.getBoundingClientRect().top),
      header: Math.round(document.querySelector(".app-header").getBoundingClientRect().top),
      dockBottom: Math.ceil(document.getElementById("mobile-dock").getBoundingClientRect().bottom),
    }));
    let now = await layout();
    assert.equal(now.top, 300, "the page starts where the visible area starts");
    assert.ok(now.header >= 300 && now.header <= 302, `the header stays in sight (${now.header})`);
    assert.ok(now.dockBottom >= 736 && now.dockBottom <= 740, `the toolbar ends at the keyboard (${now.dockBottom})`);
    // The pan moves without a resize: the visual viewport's scroll event alone moves the page.
    await page.evaluate(() => {
      window.visualViewport.offsetTop = 120;
      window.visualViewport.dispatchEvent(new Event("scroll"));
    });
    now = await layout();
    assert.equal(now.top, 120);
    await page.evaluate(() => {
      Object.assign(window.visualViewport, { height: innerHeight, offsetTop: 0 });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    assert.equal((await layout()).top, 0, "back in place once the keyboard closes");
    // The debug readout, switched on in the appearance sheet, shows the numbers behind it.
    await page.click("#open-drawer");
    await page.click("#open-settings");
    await page.check("#look-debug");
    await page.click("#close-settings");
    await page.locator("#viewport-debug").waitFor();
    assert.match(await page.locator("#viewport-debug").textContent(), /innerHeight 740[\s\S]*visualViewport 740/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("WebDAV settings stay on this phone and never put the password in localStorage", async () => {
  const { context, page, errors } = await open();
  try {
    await page.click("#open-drawer");
    await page.click("#open-sync-settings");
    await page.locator("#mobile-webdav-settings").waitFor();
    assert.equal(await page.locator("#ms-enable").isChecked(), false);
    await page.locator("#ms-enable").check();
    await page.fill("#ms-server", "https://dav.example.com/dav/");
    await page.fill("#ms-user", "tester");
    await page.fill("#ms-password", "private-test-password");
    await page.selectOption("#ms-first", "merge");
    await page.click("#ms-save-config");
    await page.waitForFunction(() => !!localStorage.getItem("minipad-mobile-webdav"));
    const stored = await page.evaluate(() => localStorage.getItem("minipad-mobile-webdav"));
    assert.equal(stored.includes("private-test-password"), false);
    assert.equal(JSON.parse(stored).enabled, true);
    assert.equal(await page.locator("#ms-password").inputValue(), "");
    assert.equal(await page.evaluate(() => window.__mobileTest.savedWebdavPassword), "private-test-password");
    await page.click("#ms-test");
    await page.waitForFunction(() => document.getElementById("ms-result").textContent.includes("连接测试成功"));
    await page.click("#ms-run");
    await page.waitForFunction(() => window.__mobileTest.lastSync?.config?.server === "https://dav.example.com/dav/");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("WebDAV queues a second Android sync instead of dropping it", async () => {
  const { context, page, errors } = await open();
  try {
    await page.click("#open-drawer");
    await page.click("#open-sync-settings");
    await page.locator("#ms-enable").check();
    await page.fill("#ms-server", "https://dav.example.com/");
    await page.fill("#ms-user", "tester");
    await page.click("#ms-save-config");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("minipad-mobile-webdav") || "{}").enabled);
    await page.evaluate(() => { window.__mobileTest.syncDelay = 350; });
    await page.click("#ms-run");
    await page.click("#ms-run");
    await page.waitForFunction(() => window.__mobileTest.syncCalls === 2, { timeout: 6000 });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("refresh button uses WebDAV when enabled and keeps local refresh when disabled", async () => {
  const { context, page, errors } = await open();
  try {
    await page.click("#refresh");
    assert.equal(await page.evaluate(() => window.__mobileTest.syncCalls || 0), 0);
    await page.click("#open-drawer");
    await page.click("#open-sync-settings");
    await page.locator("#ms-enable").check();
    await page.fill("#ms-server", "https://dav.example.com/");
    await page.fill("#ms-user", "tester");
    await page.click("#ms-save-config");
    await page.click("#close-sync-settings");
    await page.click("#refresh");
    await page.waitForFunction(() => window.__mobileTest.syncCalls === 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("WebDAV settings are visible in all four Android interface styles", async () => {
  for (const style of ["classic", "starry", "material", "paper"]) {
    const { context, page, errors } = await open({ look: { ui: style } });
    try {
      await page.click("#open-drawer");
      await page.click("#open-sync-settings");
      assert.equal(await page.locator("#mobile-webdav-settings").isVisible(), true, style);
      assert.equal(await page.locator("#ms-server").isVisible(), true, style);
      assert.equal(await page.locator("#ms-save-config").isVisible(), true, style);
      assert.deepEqual(errors, [], style);
    } finally { await context.close(); }
  }
});
