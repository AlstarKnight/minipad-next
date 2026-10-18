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
    window.__mobileTest = { disk, writes, images };
    window.__TAURI__ = { core: {
      async invoke(command, args = {}) {
        const book = disk.find((b) => b.name === args.book) || disk[0];
        if (command === "mobile_load_books") return structuredClone(disk);
        if (command === "mobile_save_note") {
          const note = book.notes.find((n) => n.name === args.name);
          if (note.content !== args.expected) throw new Error("stale expected content");
          note.content = args.content;
          writes.push({ ...args });
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
        if (command === "mobile_read_image") return images[args.path] ?? Promise.reject("missing file");
        throw new Error("Unknown command " + command);
      },
    } };
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url);
  await page.locator("#editor .ProseMirror h1").waitFor({ timeout: 10000 });
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
    await page.selectOption("#note", "二");
    await page.locator(".ProseMirror p").filter({ hasText: "第二页" }).waitFor();
    await page.selectOption("#note", "一");
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
    await page.click('[data-command="heading"]');
    await page.locator(".ProseMirror h2").filter({ hasText: "第一段" }).waitFor();
    await page.waitForFunction(() => window.__mobileTest.disk[0].notes[0].content.includes("## 第一段"));
    const saved = await page.evaluate(() => window.__mobileTest.disk[0].notes[0].content);
    await page.click("#mode");
    assert.equal(await page.locator(".ProseMirror").getAttribute("contenteditable"), "false");
    assert.equal(await page.locator("#toolbar").isVisible(), false);
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

test("desktop-only Markdown features use a lossless source fallback", async () => {
  const { context, page, errors } = await open();
  try {
    const content = "> [!fold]- 标题\n> 内容\n\n```python 描述\nprint(1)\n```";
    await page.evaluate((content) => {
      window.__mobileTest.disk[0].notes.push({
        name: "扩展语法", content, unreadable: false,
      });
    }, content);
    await page.click("#refresh");
    await page.selectOption("#note", "扩展语法");
    await page.locator("#source").waitFor({ state: "visible" });
    assert.equal(await page.locator("#editor").isVisible(), false);
    assert.equal(await page.locator("#source").inputValue(), content);
    await page.locator("#source").fill(content + "\n新的说明");
    await page.waitForFunction(() =>
      window.__mobileTest.disk[0].notes[2].content.endsWith("新的说明"));
    assert.equal(await page.evaluate(() => window.__mobileTest.disk[0].notes[2].content),
      content + "\n新的说明");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
