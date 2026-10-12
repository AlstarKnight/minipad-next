// 界面测试:用 Playwright 在 Chromium 里打开 src/index.html,跑在浏览器预览用的模拟后端上(src/js/mock.js)。
// 运行:npm run test:ui(会先运行 scripts/prepare.mjs 复制 src/vendor 里的第三方库)
// 每个测试都用新的浏览器上下文(localStorage 是空的),窗口 440×540,页面报错或输出 console.error 都算失败。
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright";
import { serve } from "../scripts/serve.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const KEY = "minipad-next-demo";

let server;
let browser;
let base;

before(async () => {
  if (!existsSync(join(SRC, "vendor", "milkdown.js"))) {
    throw new Error("src/vendor/ 里没有第三方库:先运行 node scripts/prepare.mjs(npm run test:ui 会自动运行)");
  }
  // 和 npm run preview 用同一个本地服务器,页面带着程序里的 CSP
  server = await serve(SRC);
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
});

// ---------- 模拟后端的数据 ----------
// 0.2.0 的默认设置加上 0.2.1 的备份设置。0.2.2 的编辑器设置(行号、日期格式)故意不写,
// 和从 0.2.1 升级上来的数据一样,由模拟后端补上默认值
const SETTINGS = {
  hotkey: "Ctrl+M",
  always_on_top: true,
  edge_hide: true,
  show_in_taskbar: false,
  autostart: false,
  theme: "system",
  font_size: 14,
  notes_dir: "",
  backup_enabled: true,
  backup_keep: 14,
  backup_dir: "",
};

// 拼出模拟后端存在 localStorage 里的数据(spec 第 8 节的结构)。
// books: { 笔记本名: { 页面名: 内容 } },「默认」笔记本的名字是 "";
// active: { 笔记本名: 当前页面 },modes: { 笔记本名: { 页面名: "view" } },book: 当前笔记本
function seed(books, { active = {}, modes = {}, book = "" } = {}) {
  const db = { settings: { ...SETTINGS }, books: {}, book, backups: [] };
  for (const [name, files] of Object.entries({ "": {}, ...books })) {
    const order = Object.keys(files);
    db.books[name] = {
      files: { ...files },
      meta: {
        order,
        active: active[name] ?? order[0] ?? "",
        modes: Object.fromEntries(order.map((n) => [n, modes[name]?.[n] ?? "edit"])),
      },
    };
  }
  return db;
}

// 在页面脚本之前运行。只在第一次打开时写入,刷新页面时保留模拟后端自己存下的数据
function seedStorage([key, value]) {
  try {
    if (location.protocol === "http:" && localStorage.getItem(key) === null) localStorage.setItem(key, value);
  } catch {}
}

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 界面和保存都是异步的:反复取值直到等于 expected,超时就拿最后一次取到的值报错
async function until(get, expected, message, ms = 4000) {
  const end = Date.now() + ms;
  let actual;
  for (;;) {
    try {
      actual = await get();
    } catch (e) {
      actual = e;
    }
    if (isDeepStrictEqual(actual, expected)) return;
    if (Date.now() > end) break;
    await sleep(50);
  }
  if (actual instanceof Error) assert.fail(`${message}: ${actual.message}`);
  assert.deepEqual(actual, expected, message);
}

// 同上,但每次取值前先让页面和(模拟的)磁盘同步一次
function syncUntil(h, get, expected, message) {
  return until(
    async () => {
      await h.sync();
      return get();
    },
    expected,
    message,
  );
}

// 操作页面的常用步骤
function helpers(p) {
  const h = {
    p,
    tabs: () => p.$$eval("#tabs .tab", (ts) => ts.map((t) => t.textContent.trim())),
    activeTab: () => p.$$eval("#tabs .tab.active", (ts) => ts[0]?.textContent.trim() ?? null),
    tab: (name) => p.locator("#tabs .tab").filter({ hasText: new RegExp(`^\\s*${escapeRe(name)}\\s*$`) }),
    bookName: () => p.$$eval("#book-name", (els) => els[0]?.textContent.trim() ?? null),
    // 编辑区是 Milkdown 富文本编辑器:当前页面转成 Markdown 的样子(去掉末尾的换行)、选中的文字
    editor: () => p.evaluate(() => window.__minipad?.editor().markdown().replace(/\n$/, "") ?? null),
    selection: () => p.evaluate(() => window.__minipad?.editor().selection() ?? null),
    // 光标在不在编辑区里
    editorFocused: () => p.evaluate(() => !!document.activeElement?.closest?.("#editor")),
    // 正在显示的提示文字(没显示时是空字符串)
    toast: () => p.$eval("#toast", (t) => (t.hidden ? "" : t.textContent)),
    async sync() {
      await p.waitForFunction(() => typeof window.__minipad?.sync === "function");
      await p.evaluate(() => window.__minipad.sync());
    },
    // 模拟后端里的全部笔记本(window.__mockBooks 的一份拷贝)
    mock: () => p.evaluate(() => (window.__mockBooks ? JSON.parse(JSON.stringify(window.__mockBooks)) : null)),
    mockFile: (book, name) => p.evaluate(([b, n]) => window.__mockBooks?.[b]?.files?.[n] ?? null, [book, name]),
    // 模拟后端存在 localStorage 里的数据
    stored: () => p.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), KEY),
    item: (book) => p.locator(`#books-list .book-item[data-book="${book}"]`),
    items: () =>
      p.$$eval("#books-list .book-item", (els) =>
        els.map((e) => {
          const count = /\d+/.exec(e.querySelector(".count")?.textContent ?? "");
          return {
            book: e.dataset.book,
            name: e.querySelector(".name")?.textContent.trim() ?? null,
            count: count ? Number(count[0]) : null,
            current: e.classList.contains("current"),
            disabled: e.disabled,
          };
        }),
      ),
    focusedBook: () => p.evaluate(() => document.activeElement?.closest?.(".book-item")?.dataset.book ?? null),
    async openBooks() {
      if (!(await p.isVisible("#books"))) await p.click("#btn-book");
      await p.locator("#books").waitFor();
    },
    async closeBooks() {
      if (await p.isVisible("#books")) await p.click("#btn-book");
      await p.locator("#books").waitFor({ state: "hidden" });
    },
    // 重新打开笔记本列表,读出里面的笔记本,再关上
    async listBooks() {
      await h.closeBooks();
      await h.openBooks();
      const items = await h.items();
      await h.closeBooks();
      return items;
    },
    async switchBook(book) {
      await h.openBooks();
      await h.item(book).click();
      await until(h.bookName, book || "默认", `switched to ${book || "默认"}`);
    },
    // 右键笔记本列表里的一项
    async bookMenu(book) {
      await h.openBooks();
      await h.item(book).click({ button: "right" });
      await p.locator("#ctx").waitFor();
    },
    // 右键一个标签
    async tabMenu(name) {
      await h.tab(name).click({ button: "right" });
      await p.locator("#ctx").waitFor();
    },
    // 在带输入框的对话框里填上名字并确定
    async answer(text, { click = false } = {}) {
      await p.locator("#dialog-input").waitFor();
      await p.fill("#dialog-input", text);
      if (click) await p.click("#dialog-ok");
      else await p.press("#dialog-input", "Enter");
    },
  };
  return h;
}

// 一个界面测试:新的浏览器上下文和页面,打开 index.html 等标签出来后运行 fn,
// 最后检查没有页面报错、console.error 和浏览器自带的对话框(confirm/prompt/alert)
function ui(name, ...args) {
  const fn = args.pop();
  const { seed: db } = args[0] ?? {};
  test(name, { timeout: 60_000 }, async (t) => {
    const ctx = await browser.newContext({
      viewport: { width: 440, height: 540 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    ctx.setDefaultTimeout(10_000);
    const errors = [];
    const dialogs = [];
    try {
      if (db) await ctx.addInitScript(seedStorage, [KEY, JSON.stringify(db)]);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()}`));
      page.on("dialog", (d) => {
        dialogs.push(`${d.type()}: ${d.message()}`);
        d.dismiss().catch(() => {});
      });
      const h = helpers(page);
      h.dialogs = dialogs;
      await page.goto(`${base}/index.html`);
      await page.waitForSelector("#tabs .tab");
      await fn(h);
      // 等防抖的保存(500 ms)和 save_meta(300 ms)跑完,它们出的错也要算上
      await page.waitForTimeout(600);
      assert.deepEqual(dialogs, [], "no native dialogs");
      assert.deepEqual(errors, [], "no page errors");
    } catch (e) {
      if (errors.length) t.diagnostic(`page errors: ${errors.join(" | ")}`);
      throw e;
    } finally {
      await ctx.close();
    }
  });
}

// ---------- 0.2.0 的检查 ----------
// 原来的 23 个 assert 都在下面(断言信息和原来一样),"no page errors" 由 ui() 在每个测试最后检查

describe("0.2.0 checks", () => {
  ui("welcome page: the copy button copies the code block", async ({ p }) => {
    await p.click("#editor .copy");
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    assert.ok(clip.includes("console.log"), "copy button copies code");
  });

  ui("new page: Ctrl+T adds a tab, rename it, then typing is saved", async (h) => {
    const { p } = h;
    await p.keyboard.press("Control+t");
    await p.waitForSelector("#tabs .tab input");
    await p.keyboard.type("待办");
    await p.keyboard.press("Enter");
    // 改完名字后光标回到编辑区
    await p.waitForFunction(() => !!document.activeElement?.closest?.("#editor") && !document.querySelector("#tabs .tab input"));
    await p.keyboard.type("第一行");
    await until(h.tabs, ["欢迎", "待办"], "new tab created and renamed");
    await until(() => h.mockFile("", "待办"), "第一行", "content saved without stray newline");
  });

  ui(
    "sync: external edits, added and deleted pages show up, the active tab stays",
    { seed: seed({ "": { 欢迎: "# 欢迎", 待办: "第一行" } }, { active: { "": "待办" }, modes: { "": { 欢迎: "view" } } }) },
    async (h) => {
      const { p } = h;
      // 当前页面没有未保存的修改:换成磁盘上的新内容
      await p.evaluate(() => (window.__mockFiles["待办"] = "外部改过的内容"));
      await syncUntil(h, h.editor, "外部改过的内容", "external edit shows up in editor");
      await p.evaluate(() => {
        window.__mockFiles["同步来的"] = "来自网盘";
        delete window.__mockFiles["欢迎"];
      });
      await syncUntil(h, h.tabs, ["待办", "同步来的"], "external add/delete reflected in tabs");
      assert.equal(await h.activeTab(), "待办", "active tab kept");
    },
  );

  ui(
    "sync: on a conflict the unsaved local edit is kept, warned about and then saved",
    { seed: seed({ "": { 待办: "外部改过的内容", 同步来的: "来自网盘" } }) },
    async (h) => {
      const { p } = h;
      await p.click("#editor");
      await p.keyboard.press("Control+End");
      await p.keyboard.type("!");
      // 本地的修改 500 ms 后才保存,在那之前文件在别处又被改了
      await p.evaluate(() => {
        window.__mockFiles["待办"] = "另一边的修改";
        return window.__minipad.sync();
      });
      assert.equal(await h.editor(), "外部改过的内容!", "local unsaved edit kept on conflict");
      assert.ok((await h.toast()).includes("别处也被修改"), "conflict toast shown");
      await until(() => h.mockFile("", "待办"), "外部改过的内容!", "local edit saved after conflict");
    },
  );

  ui(
    "delete page: the custom dialog names the page, Esc cancels, OK deletes",
    { seed: seed({ "": { 待办: "外部改过的内容!", 同步来的: "来自网盘" } }) },
    async (h) => {
      const { p } = h;
      await p.keyboard.press("Control+w");
      await p.locator("#dialog").waitFor();
      assert.ok((await p.textContent("#dialog-msg")).includes("待办"), "delete dialog names the page");
      await p.keyboard.press("Escape");
      assert.ok(await p.isHidden("#dialog"), "Esc cancels dialog");
      assert.ok((await h.tabs()).includes("待办"), "cancel keeps page");
      assert.ok(
        (await p.isVisible("#editor")) && !(await h.toast()).includes("隐藏"),
        "Esc in dialog does not hide the window",
      );
      await p.keyboard.press("Control+w");
      await p.locator("#dialog").waitFor();
      await p.click("#dialog-ok");
      await until(h.tabs, ["同步来的"], "confirm deletes page");
      assert.equal(h.dialogs.length, 0, "no native confirm() used");
    },
  );

  ui("settings: version shown, hotkey recorded, saved and persisted", async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    assert.ok((await p.textContent("#set-version")).includes("Minipad Next"), "version shown in settings");
    await p.click("#set-hotkey");
    await p.keyboard.press("Control+Shift+KeyK");
    assert.equal(await p.inputValue("#set-hotkey"), "Ctrl+Shift+K", "hotkey recorded");
    await p.click("#set-save");
    await until(() => p.isHidden("#settings"), true, "settings saved and closed");
    await until(async () => (await h.stored())?.settings?.hotkey, "Ctrl+Shift+K", "hotkey persisted");
  });

  ui("search: finds content that came in through sync, Enter selects the match", { seed: seed({ "": { 待办: "第一行" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => (window.__mockFiles["同步来的"] = "来自网盘"));
    await syncUntil(h, h.tabs, ["待办", "同步来的"], "synced page shows up");
    await p.keyboard.press("Control+f");
    await p.keyboard.type("网盘");
    await until(() => p.locator("#search-results .result").count(), 1, "search finds synced content");
    // 只有一个笔记本时结果前面不写笔记本名
    assert.equal(await p.textContent("#search-results .result .where"), "同步来的 · 第 1 行");
    await p.keyboard.press("Enter");
    await until(h.selection, "网盘", "search selects match");
  });

  ui("sync: when every page was deleted elsewhere a fresh 新页面 appears", { seed: seed({ "": { 同步来的: "来自网盘" } }) }, async (h) => {
    await h.p.evaluate(() => {
      for (const k of Object.keys(window.__mockFiles)) delete window.__mockFiles[k];
    });
    await syncUntil(h, h.tabs, ["新页面"], "empty folder gets a fresh page");
  });
});

// ---------- 笔记本 ----------

// 两个笔记本,各自有不同的当前页面
const TWO_BOOKS = seed(
  { "": { 甲: "甲的内容", 乙: "乙的内容", 丙: "丙的内容" }, 工作: { 周报: "周报的内容", 会议: "会议的内容" } },
  { active: { "": "乙", 工作: "会议" } },
);

describe("notebooks", () => {
  ui("the button shows 默认; Ctrl+B lists notebooks with page counts; Esc, Ctrl+B and clicks outside close it", async (h) => {
    const { p } = h;
    assert.equal(await h.bookName(), "默认", "button shows 默认 at start");
    await p.keyboard.press("Control+b");
    await p.locator("#books").waitFor();
    assert.equal(await p.textContent("#books-title"), "笔记本");
    assert.deepEqual(
      await h.items(),
      [{ book: "", name: "默认", count: 1, current: true, disabled: false }],
      "list shows 默认 with its page count",
    );
    assert.equal(await p.textContent("#books-new"), "新建笔记本…");
    assert.ok(await p.isVisible("#books-hint"), "hint shown in switch mode");
    await until(h.focusedBook, "", "opening the list focuses the current notebook");
    await p.keyboard.press("Escape");
    await until(() => p.isHidden("#books"), true, "Esc closes the list");
    assert.ok(!(await h.toast()).includes("隐藏"), "Esc only closes the list, the window stays");

    await p.click("#btn-book");
    await p.locator("#books").waitFor();
    await p.keyboard.press("Control+b");
    await until(() => p.isHidden("#books"), true, "Ctrl+B toggles the list");
    await p.click("#btn-book");
    await p.locator("#books").waitFor();
    await p.click("#status");
    await until(() => p.isHidden("#books"), true, "a click outside closes the list");
  });

  ui(
    "the list shows 默认 first, then the others in natural order",
    { seed: seed({ "": { 首页: "" }, "Book 10": { a: "" }, "Book 2": { b: "", c: "" }, Alpha: {} }) },
    async (h) => {
      const items = await h.listBooks();
      assert.deepEqual(
        items.map((i) => [i.name, i.count]),
        [
          ["默认", 1],
          ["Alpha", 0],
          ["Book 2", 2],
          ["Book 10", 1],
        ],
      );
    },
  );

  ui("a notebook created from the menu becomes current with its first page 新页面", async (h) => {
    const { p } = h;
    await h.openBooks();
    await p.click("#books-new");
    await p.locator("#dialog-input").waitFor();
    assert.ok((await p.textContent("#dialog-msg")).includes("新笔记本的名字"));
    assert.equal(await p.inputValue("#dialog-input"), "新笔记本", "dialog suggests 新笔记本");
    // 建议的名字是选中的,直接打字就替换掉
    await p.keyboard.type("工作");
    await p.keyboard.press("Enter");
    await until(h.bookName, "工作", "new notebook becomes current");
    await until(h.tabs, ["新页面"], "tab bar shows only the new notebook's first page");
    await until(async () => (await h.mock())?.["工作"]?.files, { 新页面: "" }, "the mock has the page in the notebook");
    await until(async () => (await h.stored())?.book, "工作", "current notebook is remembered");
  });

  ui("switching notebooks restores each one's tabs and active tab, also from the keyboard", { seed: TWO_BOOKS }, async (h) => {
    const { p } = h;
    assert.deepEqual(await h.tabs(), ["甲", "乙", "丙"]);
    assert.equal(await h.activeTab(), "乙");

    await h.switchBook("工作");
    await until(h.tabs, ["周报", "会议"], "tab bar shows only 工作's pages");
    assert.equal(await h.activeTab(), "会议", "工作 opens on its own active tab");
    assert.equal(await h.editor(), "会议的内容");
    await h.tab("周报").click();
    await until(h.activeTab, "周报", "tab switched inside 工作");

    await h.switchBook("");
    await until(h.tabs, ["甲", "乙", "丙"], "默认's tabs come back");
    assert.equal(await h.activeTab(), "乙", "默认's active tab comes back");
    assert.equal(await h.editor(), "乙的内容");
    assert.ok(await p.isHidden("#books"), "choosing a notebook closes the list");

    // 键盘:Ctrl+B 打开,焦点在当前笔记本上,↓ 到下一个,Enter 切换
    await p.keyboard.press("Control+b");
    await p.locator("#books").waitFor();
    await until(h.focusedBook, "", "focus starts on the current notebook");
    await p.keyboard.press("ArrowDown");
    await until(h.focusedBook, "工作", "ArrowDown moves to the next notebook");
    await p.keyboard.press("Enter");
    await until(h.bookName, "工作", "Enter switches to the focused notebook");
    await until(h.tabs, ["周报", "会议"]);
    assert.equal(await h.activeTab(), "周报", "工作 remembers the tab chosen before");
    assert.equal(await h.editor(), "周报的内容");
    assert.ok(await p.isHidden("#books"), "the list closes after switching");
    await until(async () => (await h.mock())?.["工作"]?.meta?.active, "周报", "工作's active tab is saved");
  });

  ui(
    "list keyboard: arrows move the focus, F2 renames and Delete deletes the focused notebook",
    { seed: seed({ "": { 首页: "" }, 工作: { 周报: "1" } }) },
    async (h) => {
      const { p } = h;
      await p.keyboard.press("Control+b");
      await until(h.focusedBook, "", "focus starts on the current notebook");
      await p.keyboard.press("ArrowDown");
      await until(h.focusedBook, "工作", "ArrowDown");
      await p.keyboard.press("ArrowUp");
      await until(h.focusedBook, "", "ArrowUp");
      await p.keyboard.press("ArrowDown");
      await until(h.focusedBook, "工作", "ArrowDown again");
      await p.keyboard.press("F2");
      await p.locator("#dialog-input").waitFor();
      assert.equal(await p.inputValue("#dialog-input"), "工作", "F2 asks for the focused notebook's new name");
      await p.keyboard.type("项目");
      await p.keyboard.press("Enter");
      await until(async () => (await h.mock())?.["项目"]?.files, { 周报: "1" }, "F2 renamed the notebook");

      await h.closeBooks();
      await p.keyboard.press("Control+b");
      await until(h.focusedBook, "", "focus starts on the current notebook");
      await p.keyboard.press("ArrowDown");
      await until(h.focusedBook, "项目", "ArrowDown");
      await p.keyboard.press("Delete");
      await p.locator("#dialog").waitFor();
      assert.ok((await p.textContent("#dialog-msg")).includes("「项目」"), "Delete asks about the focused notebook");
      await p.keyboard.press("Enter");
      await until(async () => "项目" in ((await h.mock()) ?? {}), false, "Delete removed the notebook");
      assert.equal(await h.bookName(), "默认");
    },
  );

  ui(
    "rename from the right-click menu moves the files; a clash with 默认 gives 默认 (2); 默认 itself is locked",
    { seed: seed({ "": { 首页: "" }, 工作: { 周报: "w1", 会议: "w2" } }) },
    async (h) => {
      const { p } = h;
      await h.bookMenu("工作");
      assert.equal(await p.textContent('#ctx button[data-act="rename"]'), "改名");
      assert.equal(await p.textContent('#ctx button[data-act="delete"]'), "删除笔记本");
      assert.ok(await p.isEnabled('#ctx button[data-act="rename"]'), "改名 enabled for 工作");
      assert.ok(await p.isEnabled('#ctx button[data-act="delete"]'), "删除笔记本 enabled for 工作");
      await p.click('#ctx button[data-act="rename"]');
      await p.locator("#dialog-input").waitFor();
      assert.ok((await p.textContent("#dialog-msg")).includes("笔记本的新名字"));
      assert.equal(await p.inputValue("#dialog-input"), "工作", "dialog starts with the old name");
      await h.answer("项目");
      await until(async () => (await h.mock())?.["项目"]?.files, { 周报: "w1", 会议: "w2" }, "pages moved to the renamed notebook");
      assert.ok(!("工作" in (await h.mock())), "the old notebook is gone from the mock");
      assert.deepEqual(
        (await h.listBooks()).map((i) => i.name),
        ["默认", "项目"],
        "list shows the new name",
      );

      // 当前笔记本改名成「默认」:名字被占用,变成「默认 (2)」
      await h.switchBook("项目");
      await h.bookMenu("项目");
      await p.click('#ctx button[data-act="rename"]');
      await h.answer("默认", { click: true });
      await until(h.bookName, "默认 (2)", "renaming to 默认 gives 默认 (2)");
      assert.deepEqual((await h.mock())?.["默认 (2)"]?.files, { 周报: "w1", 会议: "w2" });
      await until(async () => (await h.stored())?.book, "默认 (2)", "the remembered current notebook follows the rename");

      await h.bookMenu("");
      assert.ok(await p.isDisabled('#ctx button[data-act="rename"]'), "改名 disabled for 默认");
      assert.ok(await p.isDisabled('#ctx button[data-act="delete"]'), "删除笔记本 disabled for 默认");
      await p.keyboard.press("Escape");
    },
  );

  ui(
    "move a page through the tab menu; a name clash gives (2); the source keeps a page",
    { seed: seed({ "": { 甲: "a", 乙: "b" }, 工作: { 乙: "old b" } }) },
    async (h) => {
      const { p } = h;
      await h.tabMenu("甲");
      assert.deepEqual(
        await p.$$eval("#ctx button", (bs) => bs.map((b) => [b.dataset.act, b.textContent.trim()])),
        [
          ["rename", "重命名"],
          ["move", "移到笔记本…"],
          ["delete", "删除页面"],
        ],
        "tab menu items",
      );
      await p.click('#ctx button[data-act="move"]');
      await p.locator("#books").waitFor();
      assert.equal(await p.textContent("#books-title"), "把「甲」移到…", "move mode title");
      assert.ok(await h.item("").isDisabled(), "the current notebook is disabled in move mode");
      assert.equal(await p.textContent("#books-new"), "新建笔记本并移过去…");
      assert.ok(await p.isHidden("#books-hint"), "hint hidden in move mode");
      await h.item("工作").click();
      await until(h.toast, "已把「甲」移到「工作」", "move toast");
      await until(h.tabs, ["乙"], "the moved page leaves the tab bar");
      assert.equal(await h.activeTab(), "乙", "the neighbour becomes active");
      assert.equal(await h.bookName(), "默认", "stays in the current notebook");
      let m = await h.mock();
      assert.deepEqual(m[""].files, { 乙: "b" });
      assert.deepEqual(m["工作"].files, { 乙: "old b", 甲: "a" });

      // 移走最后一页,而且目标笔记本里已经有同名页面
      await h.tabMenu("乙");
      await p.click('#ctx button[data-act="move"]');
      await p.locator("#books").waitFor();
      await h.item("工作").click();
      await until(h.tabs, ["新页面"], "the source notebook keeps at least one page");
      await until(async () => (await h.mock())["工作"].files, { 乙: "old b", 甲: "a", "乙 (2)": "b" }, "name clash gives (2)");
      m = await h.mock();
      assert.deepEqual(m[""].files, { 新页面: "" });

      await h.switchBook("工作");
      await until(h.tabs, ["乙", "甲", "乙 (2)"], "moved pages are appended in the target");
    },
  );

  ui("move a page into a new notebook from the move menu", { seed: seed({ "": { 甲: "a", 乙: "b" } }) }, async (h) => {
    const { p } = h;
    await h.tabMenu("甲");
    await p.click('#ctx button[data-act="move"]');
    await p.locator("#books").waitFor();
    await p.click("#books-new");
    await h.answer("归档");
    await until(async () => (await h.mock())?.["归档"]?.files, { 甲: "a" }, "page moved into the new notebook");
    await until(h.tabs, ["乙"]);
    assert.equal(await h.bookName(), "默认", "stays in the current notebook");
  });

  ui(
    "delete through the confirm dialog; deleting the current notebook returns to 默认",
    { seed: seed({ "": { 首页: "home" }, 工作: { 周报: "1", 会议: "2" }, 旅行: { 清单: "护照" }, 空的: {} }, { book: "旅行" }) },
    async (h) => {
      const { p } = h;
      await until(h.bookName, "旅行", "starts in the remembered notebook");

      await h.bookMenu("工作");
      await p.click('#ctx button[data-act="delete"]');
      await p.locator("#dialog").waitFor();
      const msg = await p.textContent("#dialog-msg");
      assert.ok(msg.includes("「工作」") && msg.includes("2 个页面"), `dialog names the notebook and its page count: ${msg}`);
      assert.equal(await p.textContent("#dialog-ok"), "删除");
      await p.keyboard.press("Escape");
      await until(() => p.isHidden("#dialog"), true, "Esc closes the dialog");
      assert.ok("工作" in (await h.mock()), "cancel keeps the notebook");

      await h.bookMenu("工作");
      await p.click('#ctx button[data-act="delete"]');
      await p.locator("#dialog").waitFor();
      await p.click("#dialog-ok");
      await until(async () => "工作" in (await h.mock()), false, "the notebook is removed from the mock");
      assert.ok(!(await h.listBooks()).some((i) => i.book === "工作"), "the notebook is removed from the list");
      assert.equal(await h.bookName(), "旅行", "deleting another notebook keeps the current one");

      // 空笔记本的提示里不提页面数
      await h.bookMenu("空的");
      await p.click('#ctx button[data-act="delete"]');
      await p.locator("#dialog").waitFor();
      assert.ok(!(await p.textContent("#dialog-msg")).includes("个页面"), "no page count for an empty notebook");
      await p.click("#dialog-ok");
      await until(async () => "空的" in (await h.mock()), false, "the empty notebook is removed");

      await h.bookMenu("旅行");
      await p.click('#ctx button[data-act="delete"]');
      await p.locator("#dialog").waitFor();
      await p.click("#dialog-ok");
      await until(h.bookName, "默认", "deleting the current notebook returns to 默认");
      await until(h.tabs, ["首页"]);
      assert.ok(!("旅行" in (await h.mock())));
      await until(async () => (await h.stored())?.book, "", "the remembered notebook is reset");
    },
  );

  ui(
    "search finds a page in another notebook, shows the notebook and opens it there",
    { seed: seed({ "": { 首页: "hello" }, 工作: { 周报: "第一行\n本周整理了关键字的用法" } }) },
    async (h) => {
      const { p } = h;
      const where = () => p.$$eval("#search-results .result .where", (els) => els.map((e) => e.textContent.trim()));
      await p.keyboard.press("Control+f");
      await p.locator("#search-input").waitFor();
      await p.keyboard.type("关键字");
      await until(where, ["工作 › 周报 · 第 2 行"], "the result shows the notebook label");
      await p.keyboard.press("Enter");
      await until(h.bookName, "工作", "opening the result switches notebook");
      await until(h.activeTab, "周报");
      await until(h.selection, "关键字", "the match is selected");

      await p.keyboard.press("Control+f");
      await p.fill("#search-input", "周报");
      await until(where, ["页面标题 · 工作"], "a title match shows the notebook");
      await p.keyboard.press("Escape");
    },
  );

  ui(
    "sync adds notebooks created elsewhere and drops removed ones; losing the current one falls back to 默认",
    { seed: seed({ "": { 首页: "home" }, 工作: { 周报: "1" } }) },
    async (h) => {
      const { p } = h;
      const books = async () => (await h.listBooks()).map((i) => [i.name, i.count]);
      await p.evaluate(() => {
        window.__mockBooks["旅行"] = { files: { 清单: "护照" }, meta: { order: ["清单"], active: "清单", modes: {} } };
      });
      await syncUntil(
        h,
        books,
        [
          ["默认", 1],
          ["工作", 1],
          ["旅行", 1],
        ],
        "a notebook added elsewhere shows up in the list",
      );
      await p.evaluate(() => delete window.__mockBooks["工作"]);
      await syncUntil(
        h,
        books,
        [
          ["默认", 1],
          ["旅行", 1],
        ],
        "a notebook removed elsewhere disappears",
      );

      await h.switchBook("旅行");
      await until(h.tabs, ["清单"]);
      await p.evaluate(() => delete window.__mockBooks["旅行"]);
      await syncUntil(h, h.bookName, "默认", "losing the current notebook falls back to 默认");
      await until(h.tabs, ["首页"]);
    },
  );

  ui("the current notebook and its active page survive a reload", { seed: TWO_BOOKS }, async (h) => {
    const { p } = h;
    await h.switchBook("工作");
    await h.tab("周报").click();
    await until(
      async () => {
        const db = await h.stored();
        return [db?.book, db?.books?.["工作"]?.meta?.active];
      },
      ["工作", "周报"],
      "current notebook and active tab saved",
    );
    await p.reload();
    await p.waitForSelector("#tabs .tab");
    await until(h.bookName, "工作", "the current notebook survives the reload");
    await until(h.tabs, ["周报", "会议"]);
    assert.equal(await h.activeTab(), "周报");
  });

  ui("opening an empty notebook gives it a 新页面", { seed: seed({ "": { 首页: "home" }, 空的: {} }) }, async (h) => {
    assert.equal((await h.listBooks()).find((i) => i.book === "空的")?.count, 0, "the list shows 0 pages");
    await h.switchBook("空的");
    await until(h.tabs, ["新页面"], "the empty notebook gets a 新页面");
    await until(async () => (await h.mock())?.["空的"]?.files, { 新页面: "" }, "the page is created through create_note");
  });

  ui("starting in an empty current notebook gives it a 新页面", { seed: seed({ "": { 首页: "home" }, 空的: {} }, { book: "空的" }) }, async (h) => {
    await until(h.bookName, "空的");
    await until(h.tabs, ["新页面"], "the empty notebook gets a 新页面 at startup");
    await until(async () => (await h.mock())?.["空的"]?.files, { 新页面: "" });
  });

  ui(
    "0.2.0 preview data is moved into 默认",
    {
      seed: {
        settings: { hotkey: "Ctrl+M", always_on_top: true, edge_hide: true, show_in_taskbar: false, autostart: false, theme: "system", font_size: 14, notes_dir: "" },
        files: { 旧页面: "旧内容", 第二页: "2" },
        meta: { order: ["第二页", "旧页面"], active: "旧页面", modes: { 第二页: "view" } },
      },
    },
    async (h) => {
      const { p } = h;
      await until(h.tabs, ["第二页", "旧页面"], "old pages are in 默认");
      assert.equal(await h.activeTab(), "旧页面");
      assert.equal(await h.bookName(), "默认");
      assert.deepEqual((await h.mock())?.[""]?.files, { 旧页面: "旧内容", 第二页: "2" });
      await p.click("#btn-settings");
      await until(() => p.inputValue("#set-backup-keep"), "14", "old settings get the backup defaults");
      assert.ok(await p.isChecked("#set-backup"));
    },
  );
});

// ---------- 设置和对话框 ----------

describe("settings and dialogs", () => {
  ui("settings: the daily backup fields load the defaults, toggle, clamp and persist", async (h) => {
    const { p } = h;
    const saved = async () => {
      const s = (await h.stored())?.settings ?? {};
      return [s.backup_enabled, s.backup_keep, s.backup_dir];
    };
    const fields = ["#set-backup-keep", "#set-backup-dir", "#set-pick-backup"];

    await p.click("#btn-settings");
    await p.locator("#settings").waitFor();
    assert.equal(await p.isChecked("#set-backup"), true, "backup is on by default");
    assert.equal(await p.inputValue("#set-backup-keep"), "14", "keeps 14 by default");
    assert.equal(await p.inputValue("#set-backup-dir"), "", "default location");
    await until(() => p.getAttribute("#set-backup-dir", "placeholder"), "(浏览器预览)", "placeholder shows the backup folder");
    await until(() => p.textContent("#set-backup-info"), "还没有备份,今天第一次保存时会自动备份", "no backup yet");

    await p.uncheck("#set-backup");
    for (const f of fields) assert.ok(await p.isDisabled(f), `${f} disabled while backup is off`);
    assert.equal(await p.textContent("#set-backup-info"), "自动备份已关闭");
    await p.check("#set-backup");
    for (const f of fields) assert.ok(await p.isEnabled(f), `${f} enabled again`);

    await p.fill("#set-backup-keep", "999");
    await p.fill("#set-backup-dir", "  D:\\笔记备份  ");
    await p.click("#set-save");
    await until(() => p.isHidden("#settings"), true, "settings saved and closed");
    await until(saved, [true, 365, "D:\\笔记备份"], "keep is clamped to 365, the folder trimmed");

    await p.click("#btn-settings");
    await p.locator("#settings").waitFor();
    assert.equal(await p.inputValue("#set-backup-keep"), "365");
    assert.equal(await p.inputValue("#set-backup-dir"), "D:\\笔记备份");
    await p.fill("#set-backup-keep", "-5");
    await p.uncheck("#set-backup");
    await p.click("#set-save");
    await until(saved, [false, 1, "D:\\笔记备份"], "keep is clamped to 1, backup off");

    await p.click("#btn-settings");
    await p.locator("#settings").waitFor();
    assert.equal(await p.isChecked("#set-backup"), false, "backup stays off");
    assert.equal(await p.inputValue("#set-backup-keep"), "1");
    for (const f of fields) assert.ok(await p.isDisabled(f), `${f} disabled when opened with backup off`);
    // 份数留空就用默认的 14
    await p.check("#set-backup");
    await p.fill("#set-backup-keep", "");
    await p.click("#set-save");
    await until(saved, [true, 14, "D:\\笔记备份"], "an empty count falls back to 14");
  });

  ui("settings: the backup info shows today's backup after the first change", { seed: seed({ "": { 首页: "" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.type("hello");
    await until(() => h.mockFile("", "首页"), "hello", "page saved");
    const today = await p.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    await until(async () => (await h.stored())?.backups, [today], "the mock records today's backup once");
    await p.click("#btn-settings");
    await until(() => p.textContent("#set-backup-info"), `最近一次:${today},共 1 份`, "backup info shows it");
    await p.click("#set-cancel");
  });

  ui("dialogs and tab renaming ignore Enter while an IME is composing", async (h) => {
    const { p } = h;
    // 输入法组字时按的 Enter:isComposing 为 true,或者 keyCode 是 229
    const composingEnter = (sel, init) =>
      p.$eval(
        sel,
        (el, init) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...init })),
        init,
      );

    await h.openBooks();
    await p.click("#books-new");
    await p.locator("#dialog-input").waitFor();
    await p.fill("#dialog-input", "工作");
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await composingEnter("#dialog-input", init);
      await sleep(150);
      assert.ok(await p.isVisible("#dialog"), `Enter with ${JSON.stringify(init)} leaves the dialog open`);
    }
    await p.keyboard.press("Enter");
    await until(h.bookName, "工作", "a plain Enter still confirms");
    await until(h.tabs, ["新页面"]);

    await h.tab("新页面").dblclick();
    await p.locator("#tabs .tab input").waitFor();
    await p.fill("#tabs .tab input", "计划");
    await composingEnter("#tabs .tab input", { isComposing: true });
    await sleep(150);
    assert.ok(await p.isVisible("#tabs .tab input"), "composing Enter leaves the tab rename open");
    await p.keyboard.press("Enter");
    await until(h.tabs, ["计划"], "a plain Enter renames the tab");
    await until(async () => (await h.mock())?.["工作"]?.files, { 计划: "" });
  });
});

// ---------- 编辑区(0.2.4 起是 Milkdown 富文本编辑器):撤销记录、Markdown 写法、任务、Tab、F5、工具栏 ----------

describe("editor", () => {
  ui(
    "each page keeps its own undo history across page switches",
    { seed: seed({ "": { 甲: "甲的内容", 乙: "乙的内容" } }) },
    async (h) => {
      const { p } = h;
      await p.click("#editor");
      await p.keyboard.press("Control+End");
      await p.keyboard.type("!!");
      await until(() => h.mockFile("", "甲"), "甲的内容!!", "typing on 甲 is saved");
      await h.tab("乙").click();
      await until(h.editor, "乙的内容", "乙 is shown");
      assert.ok(await h.editorFocused(), "after clicking a tab the cursor is in the editor");
      await p.keyboard.press("Control+End");
      await p.keyboard.type("??");
      await h.tab("甲").click();
      await until(h.editor, "甲的内容!!", "back on 甲");
      // 切到第 2 页再切回来,Ctrl+Z 还能撤销刚才打的字
      await p.keyboard.press("Control+z");
      assert.equal(await h.editor(), "甲的内容", "Ctrl+Z undoes what was typed before switching pages");
      await until(() => h.mockFile("", "甲"), "甲的内容", "the undo is saved");
      await p.keyboard.press("Control+y");
      assert.equal(await h.editor(), "甲的内容!!", "Ctrl+Y redoes it");
      await p.keyboard.press("Control+z");
      await p.keyboard.press("Control+Shift+z");
      assert.equal(await h.editor(), "甲的内容!!", "so does Ctrl+Shift+Z");
      // 乙 的撤销记录是它自己的
      await h.tab("乙").click();
      await until(h.editor, "乙的内容??", "乙 kept its text");
      await p.keyboard.press("Control+z");
      assert.equal(await h.editor(), "乙的内容", "乙 undoes its own typing");
      await p.keyboard.press("Control+z");
      assert.equal(await h.editor(), "乙的内容", "and has nothing older to undo");
      await until(() => h.mockFile("", "乙"), "乙的内容", "乙 saved");
      await until(() => h.mockFile("", "甲"), "甲的内容!!", "甲 saved");
    },
  );

  ui("a change synced from disk is an undo step of its own", { seed: seed({ "": { 待办: "第一行" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.press("Control+End");
    await p.keyboard.type("!");
    await p.keyboard.press("Control+s");
    await until(() => h.mockFile("", "待办"), "第一行!", "typing saved");
    await p.evaluate(() => (window.__mockFiles["待办"] = "第一行!\n网盘同步来的"));
    await syncUntil(h, h.editor, "第一行!\n网盘同步来的", "the synced text shows up");
    assert.ok(await h.editorFocused(), "the editor keeps the focus");
    await p.keyboard.press("Control+z");
    assert.equal(await h.editor(), "第一行!", "Ctrl+Z takes back only the synced change");
    await until(() => h.mockFile("", "待办"), "第一行!", "and saves that");
    await p.keyboard.press("Control+z");
    assert.equal(await h.editor(), "第一行", "the next Ctrl+Z undoes the typing");
  });

  ui("Markdown shortcuts format the text while typing, and the file is saved as Markdown", { seed: seed({ "": { 页: "" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    for (const step of ["# 标题", "Enter", "**粗体**和`代码`", "Enter", "- 苹果", "Enter", "香蕉", "Enter", "Enter", "1. 第一", "Enter", "第二", "Enter", "Enter", "> 引用"]) {
      if (step === "Enter") await p.keyboard.press("Enter");
      else await p.keyboard.type(step);
    }
    const html = (sel) => p.$$eval(`#editor .ProseMirror ${sel}`, (els) => els.map((e) => e.textContent));
    assert.deepEqual(await html("h1"), ["标题"], "# makes a heading");
    assert.deepEqual(await html("strong"), ["粗体"], "** makes bold");
    assert.deepEqual(await html(":not(pre) > code"), ["代码"], "backticks make inline code");
    assert.deepEqual(await html("ul > li"), ["苹果", "香蕉"], "- starts a list and Enter continues it");
    assert.deepEqual(await html("ol > li"), ["第一", "第二"], "1. starts a numbered list");
    assert.deepEqual(await html("blockquote"), ["引用"], "> makes a quote");
    const md = "# 标题\n\n**粗体**和`代码`\n\n- 苹果\n- 香蕉\n\n1. 第一\n2. 第二\n\n> 引用";
    assert.equal(await h.editor(), md, "the page is Markdown underneath");
    await until(() => h.mockFile("", "页"), md, "saved as Markdown");
  });

  ui(
    "opening a page does not rewrite its file; the first change saves it in the editor's Markdown style",
    { seed: seed({ "": { 页: "* 甲\n* 乙\n\n一行\n下一行" } }) },
    async (h) => {
      const { p } = h;
      await p.locator("#editor .ProseMirror li").first().waitFor();
      assert.deepEqual(await p.$$eval("#editor .ProseMirror br", (els) => els.length), 1, "a single line break stays a line break");
      await sleep(800);
      assert.equal(await h.mockFile("", "页"), "* 甲\n* 乙\n\n一行\n下一行", "only looking at a page keeps the file as it was");
      await p.click("#editor .ProseMirror li >> nth=1");
      await p.keyboard.press("End");
      await p.keyboard.type("!");
      await until(() => h.mockFile("", "页"), "- 甲\n- 乙!\n\n一行\n下一行", "after a change the list uses -, line breaks are kept");
    },
  );

  ui("tasks: [ ] starts a task, Ctrl+Enter and clicking the box check it", { seed: seed({ "": { 待办: "买菜\n\n- 牛奶" } }) }, async (h) => {
    const { p } = h;
    const tasks = () => p.$$eval('#editor li[data-item-type="task"]', (els) => els.map((e) => [e.textContent, e.dataset.checked === "true"]));
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("Control+Enter");
    // 紧挨着的两个列表,第二个用 * 写,免得打开时合成一个
    assert.equal(await h.editor(), "- [ ] 买菜\n\n* 牛奶", "Ctrl+Enter turns a paragraph into an open task");
    await p.keyboard.press("Control+Enter");
    assert.equal(await h.editor(), "- [x] 买菜\n\n* 牛奶", "Ctrl+Enter checks it");
    await p.keyboard.press("Control+Enter");
    assert.equal(await h.editor(), "- [ ] 买菜\n\n* 牛奶", "and unchecks it");
    await p.click("#editor .ProseMirror li >> text=牛奶");
    await p.keyboard.press("Control+Enter");
    assert.deepEqual(await tasks(), [["买菜", false], ["牛奶", false]], "a list item gets a checkbox");
    // 点方框勾选
    const box = await p.locator('#editor li[data-item-type="task"] >> nth=1').boundingBox();
    await p.mouse.click(box.x - 10, box.y + box.height / 2);
    assert.deepEqual(await tasks(), [["买菜", false], ["牛奶", true]], "clicking the box checks it");
    await p.keyboard.press("Control+a");
    await p.keyboard.press("Control+Enter");
    assert.deepEqual(await tasks(), [["买菜", true], ["牛奶", false]], "with everything selected each task is toggled");
    await until(() => h.mockFile("", "待办"), "- [x] 买菜\n\n* [ ] 牛奶", "saved");
  });

  ui("Tab indents list items; in a code block Tab inserts a tab; Tab never leaves the editor", { seed: seed({ "": { 页: "- 甲\n- 乙\n\n```\ncode\n```" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror li >> text=乙");
    await p.keyboard.press("End");
    await p.keyboard.press("Tab");
    assert.equal(await h.editor(), "- 甲\n  - 乙\n\n```\ncode\n```", "Tab makes 乙 a sub item");
    await p.keyboard.press("Shift+Tab");
    assert.equal(await h.editor(), "- 甲\n- 乙\n\n```\ncode\n```", "Shift+Tab moves it back");
    // 代码块是最后一块:Ctrl+End 到代码的末尾,Home 到这一行的开头
    await p.keyboard.press("Control+End");
    await p.keyboard.press("Home");
    await until(h.selection, "", "the cursor is in the code");
    await p.keyboard.press("Tab");
    assert.equal(await h.editor(), "- 甲\n- 乙\n\n```\n\tcode\n```", "Tab in code inserts a tab");
    assert.ok(await h.editorFocused(), "the focus stays in the editor");
  });

  ui("Enter after a checked task starts an open one; --- and a trailing code block can be typed past", { seed: seed({ "": { 页: "- [x] 做完了" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror li");
    await p.keyboard.press("End");
    await until(h.selection, "", "the cursor is in the task");
    await p.keyboard.press("Enter");
    await p.keyboard.type("下一项");
    assert.equal(await h.editor(), "- [x] 做完了\n- [ ] 下一项", "the new task is not checked");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    // 打完 --- 光标在分隔线下面的新段落里,接着打字不会把分隔线换掉
    await p.keyboard.type("---");
    await p.keyboard.type("x");
    await p.keyboard.press("Enter");
    await p.keyboard.type("```js");
    await p.keyboard.press("Enter");
    await p.keyboard.type("a");
    // 代码块是最后一块时,在最后一行按 ↓ 到它下面
    await p.keyboard.press("ArrowDown");
    await p.keyboard.type("后面");
    assert.equal(await h.editor(), "- [x] 做完了\n- [ ] 下一项\n\n---\n\nx\n\n```js\na\n```\n\n后面");
    await until(() => h.mockFile("", "页"), "- [x] 做完了\n- [ ] 下一项\n\n---\n\nx\n\n```js\na\n```\n\n后面", "saved");
  });

  ui("F5 inserts the date and time at the cursor, in the format set in the settings", { seed: seed({ "": { 日记: "今天" } }) }, async (h) => {
    const { p } = h;
    // F5 不能刷新页面
    await p.evaluate(() => (window.__notReloaded = true));
    await p.click("#editor");
    await p.keyboard.press("Control+End");
    await p.keyboard.press("F5");
    assert.match(await h.editor(), /^今天\d{1,2}:\d{2} \d{4}\/\d{1,2}\/\d{1,2}$/, "the default format is Notepad's H:mm yyyy/M/d");

    await p.click("#btn-settings");
    await p.locator("#settings").waitFor();
    assert.equal(await p.inputValue("#set-date-format"), "H:mm yyyy/M/d", "the settings show the default format");
    await p.fill("#set-date-format", " yyyy-MM-dd ");
    const today = await p.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    await until(() => p.textContent("#set-date-preview"), `现在按 F5 会插入:${today}`, "the preview follows the input");
    await p.keyboard.press("F5");
    assert.equal(await p.inputValue("#set-date-format"), " yyyy-MM-dd ", "F5 in an input box inserts nothing");
    await p.click("#set-save");
    await until(() => p.isHidden("#settings"), true, "settings saved and closed");
    await until(async () => (await h.stored())?.settings?.date_format, "yyyy-MM-dd", "the format is saved trimmed");

    await p.click("#editor");
    await p.keyboard.press("Control+a");
    await p.keyboard.press("F5");
    assert.equal(await h.editor(), today, "F5 replaces the selection with the new format");
    await until(() => h.mockFile("", "日记"), today, "saved");

    // 搜索框开着时 F5 什么也不做
    await p.keyboard.press("Control+f");
    await p.locator("#search").waitFor();
    await p.keyboard.press("F5");
    await p.keyboard.press("Escape");
    assert.equal(await h.editor(), today, "nothing inserted from the search box");
    assert.equal(await p.evaluate(() => window.__notReloaded), true, "F5 never reloads the page");
  });

  ui("with the format bar hidden a toolbar formats selected text; Ctrl+B bolds a selection and opens the notebooks without one", { seed: seed({ "": { 页: "一段文字" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("Shift+Home");
    await sleep(200);
    assert.ok(await p.isHidden("#toolbar"), "no floating toolbar while the format bar is shown");
    await p.click("#btn-format");
    await until(() => p.isHidden("#format-bar"), true);
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("End");
    assert.ok(await p.isHidden("#toolbar"), "no toolbar without a selection");
    await p.keyboard.press("Shift+ArrowLeft");
    await p.keyboard.press("Shift+ArrowLeft");
    await p.locator("#toolbar").waitFor();
    await p.click('#toolbar [data-cmd="strong"]');
    assert.equal(await h.editor(), "一段**文字**", "the B button makes the selection bold");
    assert.ok(await p.locator('#toolbar [data-cmd="strong"].on').isVisible(), "and shows it is on");
    await p.click('#toolbar [data-cmd="link"]');
    await h.answer("https://example.com");
    await until(h.editor, "一段**[文字](https://example.com)**", "the link button asks for the address");
    await p.keyboard.press("Control+b");
    await until(h.editor, "一段[文字](https://example.com)", "Ctrl+B with a selection toggles bold");
    assert.ok(await p.isHidden("#books"), "and does not open the notebook list");
    await p.keyboard.press("End");
    await until(h.selection, "", "nothing selected");
    await p.keyboard.press("Control+b");
    await p.locator("#books").waitFor();
    await p.keyboard.press("Escape");
    // Ctrl+点击链接用浏览器打开
    await p.evaluate(() => {
      window.__opened = [];
      window.open = (url) => window.__opened.push(url);
    });
    await p.click("#editor a", { modifiers: ["Control"] });
    assert.deepEqual(await p.evaluate(() => window.__opened), ["https://example.com"], "Ctrl+click opens the link");
  });

  ui("Esc hides the window even with text selected in the editor", { seed: seed({ "": { 页: "一些文字" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.press("Control+a");
    assert.equal(await h.selection(), "一些文字");
    await p.keyboard.press("Escape");
    await until(async () => (await h.toast()).includes("隐藏"), true, "Esc hides the window");
  });
});

// ---------- 代码块 ----------
const CODE_PAGE = {
  "": {
    代码: [
      "```js 牛奶测试",
      "const s = 'A previously isolated, newly discovered, randomly mating mammalian species raises its young for 18 years';",
      "function f(x) {",
      "  return x * 2;",
      "}",
      "```",
      "",
      "```",
      "没有语言也没有标题",
      "```",
    ].join("\n"),
  },
};

describe("code blocks", () => {
  ui("a code block shows its title, language, line numbers and wraps long lines; it folds and copies", { seed: seed(CODE_PAGE) }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock").first().waitFor();
    const blocks = () =>
      p.$$eval("#editor .codeblock", (els) =>
        els.map((e) => ({
          title: e.querySelector(".cb-title").value,
          lang: e.querySelector(".cb-lang").value,
          lines: e.querySelectorAll(".cb-gutter span").length,
        })),
      );
    assert.deepEqual(await blocks(), [
      { title: "牛奶测试", lang: "js", lines: 4 },
      { title: "", lang: "", lines: 1 },
    ]);
    const first = p.locator("#editor .codeblock").first();
    assert.deepEqual(await first.locator(".cb-gutter span").allTextContents(), ["1", "2", "3", "4"], "every line is numbered");
    // 第 1 行很长,换了行;第 2 行的行号要在它下面好几行的位置
    const tops = await first.locator(".cb-gutter span").evaluateAll((els) => els.map((e) => e.offsetTop));
    assert.ok(tops[1] - tops[0] > tops[2] - tops[1] * 1.5, "a wrapped line keeps its number at its first row");
    assert.ok((await first.locator(".hljs-keyword").count()) > 0, "the code is highlighted");
    assert.equal(await first.locator("pre").evaluate((e) => e.scrollWidth - e.clientWidth), 0, "long lines wrap");

    await first.locator(".cb-toggle").click();
    assert.ok(await first.locator("pre").isHidden(), "the toggle folds the code");
    assert.equal(await first.locator(".cb-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(await first.locator(".cb-count").textContent(), "4 行", "a folded block says how many lines it has");
    await first.locator(".cb-toggle").click();
    assert.ok(await first.locator("pre").isVisible(), "and unfolds it again");

    await first.locator(".copy").click();
    await until(() => first.locator(".copy").evaluate((b) => b.classList.contains("done")), true, "the copy button shows it copied");
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    assert.equal(clip, CODE_PAGE[""].代码.split("\n").slice(1, 5).join("\n"), "copies the code without line numbers");
    await sleep(600);
    assert.equal(await h.mockFile("", "代码"), CODE_PAGE[""].代码, "folding and copying do not change the file");
  });

  ui("the title and language are edited right on the card and saved in the file", { seed: seed(CODE_PAGE) }, async (h) => {
    const { p } = h;
    const second = p.locator("#editor .codeblock >> nth=1");
    await second.waitFor();
    await second.locator(".cb-title").click();
    await p.keyboard.type("新标题");
    await p.keyboard.press("Enter");
    assert.ok(await h.editorFocused(), "Enter puts the cursor back into the code");
    await until(h.editor, CODE_PAGE[""].代码.replace("```\n没有", "```新标题\n没有"), "a title without a language");
    await second.locator(".cb-lang").click();
    await p.keyboard.type("py");
    await p.keyboard.press("Enter");
    await until(h.editor, CODE_PAGE[""].代码.replace("```\n没有", "```py 新标题\n没有"), "the language goes before the title");
    // 英文标题的第一个词像语言名,前面补 text
    const first = p.locator("#editor .codeblock").first();
    await first.locator(".cb-lang").fill("");
    await first.locator(".cb-title").fill("Hello world");
    await first.locator(".cb-title").press("Enter");
    await until(async () => (await h.editor()).split("\n")[0], "```text Hello world", "an English title without a language gets text in front");
    // Esc 放弃修改,窗口不隐藏
    await first.locator(".cb-title").fill("不要了");
    await first.locator(".cb-title").press("Escape");
    assert.equal(await first.locator(".cb-title").inputValue(), "Hello world", "Esc puts the old title back");
    assert.ok(!(await h.toast()).includes("隐藏"), "and does not hide the window");
    await until(async () => (await h.mockFile("", "代码")).split("\n")[0], "```text Hello world", "saved");
    // Ctrl+Z 撤销标题和语言的修改
    await p.keyboard.press("Control+z");
    await until(async () => (await h.editor()).split("\n")[0], "```js 牛奶测试", "undo takes the title and language back");
  });

  ui("typing ``` and Enter starts a code block", { seed: seed({ "": { 页: "" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.type("```js");
    await p.keyboard.press("Enter");
    await p.keyboard.type("let a = 1");
    await p.locator("#editor .codeblock").waitFor();
    assert.equal(await h.editor(), "```js\nlet a = 1\n```");
  });

  ui("code line numbers can be turned off in the settings", { seed: seed(CODE_PAGE) }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock").first().waitFor();
    const numbered = () => p.$eval("#editor .cb-gutter", (e) => getComputedStyle(e).display !== "none");
    assert.equal(await numbered(), true, "on by default");
    await p.click("#btn-settings");
    await p.locator("#settings").waitFor();
    assert.equal(await p.isChecked("#set-code-lines"), true);
    await p.uncheck("#set-code-lines");
    await p.click("#set-save");
    await until(numbered, false, "line numbers hidden");
    await until(async () => (await h.stored())?.settings?.code_line_numbers, false, "the setting is saved");
    await p.click("#btn-settings");
    await p.locator("#settings").waitFor();
    assert.equal(await p.isChecked("#set-code-lines"), false, "the checkbox remembers it");
    await p.check("#set-code-lines");
    await p.click("#set-save");
    await until(numbered, true, "line numbers back");
  });
});

// ---------- 格式栏 ----------
describe("format bar", () => {
  const fb = (cmd) => `#format-bar [data-cmd="${cmd}"]`;

  ui("the format bar formats text, follows the cursor and can be hidden", { seed: seed({ "": { 页: "一段文字\n\n第二段" } }) }, async (h) => {
    const { p } = h;
    assert.ok(await p.isVisible("#format-bar"), "shown by default");
    await p.click("#editor .ProseMirror p >> nth=0");
    await p.keyboard.press("End");
    await until(h.selection, "", "the cursor is in the first paragraph");
    assert.ok(await p.isDisabled(fb("undo")), "nothing to undo yet");
    // 正文 / 标题下拉
    assert.equal((await p.textContent(fb("block"))).trim(), "正文");
    await p.click(fb("block"));
    await p.click('#ctx [data-act="h2"]');
    assert.equal(await h.editor(), "## 一段文字\n\n第二段", "the menu turns the paragraph into a heading");
    assert.equal((await p.textContent(fb("block"))).trim(), "标题 2", "and shows the heading level");
    assert.ok(await h.editorFocused(), "the cursor stays in the editor");
    await p.click(fb("undo"));
    assert.equal(await h.editor(), "一段文字\n\n第二段", "undo button");
    await p.click(fb("redo"));
    assert.equal(await h.editor(), "## 一段文字\n\n第二段", "redo button");
    // 选中文字加粗
    await p.keyboard.press("Shift+Home");
    await p.click(fb("strong"));
    assert.equal(await h.editor(), "## **一段文字**\n\n第二段");
    assert.ok(await p.locator(`${fb("strong")}.on`).isVisible(), "bold shows as on");
    await p.keyboard.press("End");
    // 列表:点一下变列表,再点取消,编号和列表互换
    await p.click("#editor .ProseMirror p >> text=第二段");
    await p.click(fb("list"));
    assert.equal(await h.editor(), "## **一段文字**\n\n- 第二段");
    await p.click(fb("ol"));
    assert.equal(await h.editor(), "## **一段文字**\n\n1. 第二段", "the numbered list button switches the list");
    await p.click(fb("ol"));
    assert.equal(await h.editor(), "## **一段文字**\n\n第二段", "and clicking it again ends the list");
    await p.keyboard.press("End");
    await p.click(fb("hr"));
    await p.keyboard.type("下面");
    await p.click(fb("table"));
    await p.keyboard.type("格");
    assert.match(await h.editor(), /^## \*\*一段文字\*\*\n\n第二段\n\n---\n\n下面\n\n\| 格 +\| +\| +\|\n\| :?-+ \|/, "the rule and the table go after the paragraph, the cursor into them");
    // 收起和打开
    await p.click("#format-bar .fb-hide");
    await until(() => p.isHidden("#format-bar"), true, "the arrow hides the bar");
    await until(async () => (await h.stored())?.settings?.format_bar, false, "remembered");
    assert.ok(await h.editorFocused(), "the cursor goes back to the editor");
    await p.click("#btn-format");
    await until(() => p.isVisible("#format-bar"), true, "Aa shows it again");
    await until(async () => (await h.stored())?.settings?.format_bar, true);
  });

  ui("text and background colors are saved as spans in the Markdown", { seed: seed({ "": { 页: '红<span style="color: #df2a3f">字</span>' } }) }, async (h) => {
    const { p } = h;
    assert.equal(await p.locator('#editor span[data-color="#df2a3f"]').textContent(), "字", "a colored span in the file shows in color");
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+ArrowLeft");
    await until(h.selection, "字");
    assert.ok(await p.locator(`${fb("color")}.on`).isVisible(), "the color button shows the selection has a color");
    await p.click(fb("color"));
    await p.locator(".fb-pop").waitFor();
    assert.ok(await p.locator('.fb-pop .fb-swatch.on[data-color="#df2a3f"]').isVisible(), "the current color is marked");
    await p.click('.fb-pop .fb-swatch[data-color="#117cee"]');
    assert.equal(await h.editor(), '红<span style="color: #117cee">字</span>', "a new text color");
    await p.keyboard.press("Shift+Home");
    await p.click(fb("bg"));
    await p.click('.fb-pop .fb-swatch[data-color="#fbe9a6"]');
    assert.equal(
      await h.editor(),
      '<span style="background-color: #fbe9a6">红<span style="color: #117cee">字</span></span>',
      "background color on both characters",
    );
    await p.click(fb("color"));
    await p.click(".fb-pop .fb-none");
    assert.equal(await h.editor(), '<span style="background-color: #fbe9a6">红字</span>', "默认颜色 removes the text color");
    await until(() => h.mockFile("", "页"), '<span style="background-color: #fbe9a6">红字</span>', "saved");
    // Esc 只关颜色板
    await p.click(fb("bg"));
    await p.locator(".fb-pop").waitFor();
    await p.keyboard.press("Escape");
    await until(() => p.isHidden(".fb-pop"), true, "Esc closes the palette");
    assert.equal(await h.toast(), "", "and does not hide the window");
  });

  ui("the buttons on the bar can be chosen", { seed: seed({ "": { 页: "文字" } }) }, async (h) => {
    const { p } = h;
    await p.click("#format-bar .fb-more");
    await p.locator(".fb-pop .fb-checks").waitFor();
    await p.uncheck('.fb-pop input[value="strike"]');
    await p.uncheck('.fb-pop input[value="undo"]');
    await p.uncheck('.fb-pop input[value="redo"]');
    assert.ok(await p.isHidden(fb("strike")), "unchecked buttons disappear");
    assert.ok(await p.isHidden("#format-bar .fb-items > .sep >> nth=0"), "a separator with nothing before it goes too");
    await until(async () => (await h.stored())?.settings?.format_bar_hidden, ["undo", "redo", "strike"], "remembered");
    await p.reload();
    await p.waitForSelector(fb("strong"));
    assert.ok(await p.isHidden(fb("strike")), "still hidden after a restart");
    assert.ok(await p.isVisible(fb("strong")), "the others stay");
  });

  ui("shell code is colored like bash, with command names and options", { seed: seed({ "": { 页: "```shell\n./adb shell sh /x/start.sh\nnpm run build --prod\n```" } }) }, async (h) => {
    const { p } = h;
    const colored = () => p.$$eval("#editor pre code [class*=hljs]", (els) => els.map((e) => [e.className, e.textContent]));
    await until(colored, [
      ["hljs-title function_", "./adb"],
      ["hljs-title function_", "npm"],
      ["hljs-attr", "--prod"],
    ], "commands and options are colored");
  });
});

// ---------- 明暗切换、强调色 ----------
describe("theme and accent", () => {
  ui("the sun / moon button switches between light and dark and remembers it", { seed: seed({ "": { 页: "文字" } }) }, async (h) => {
    const { p } = h;
    const theme = () => p.evaluate(() => document.documentElement.dataset.theme);
    const start = await theme();
    await p.click("#btn-theme");
    await until(theme, start === "dark" ? "light" : "dark", "the theme flips");
    await until(async () => (await h.stored())?.settings?.theme, start === "dark" ? "light" : "dark", "and is saved");
    await p.click("#btn-theme");
    await until(theme, start, "and flips back");
    assert.equal(await p.getAttribute("#btn-settings", "title"), "设置");
  });

  ui("an accent color, also a gradient, is picked in the settings and colors the active tab", { seed: seed({ "": { 甲: "一", 乙: "二" } }) }, async (h) => {
    const { p } = h;
    const marker = () => p.$eval(".tab.active", (t) => getComputedStyle(t, "::before").backgroundImage);
    assert.equal(await marker(), "none", "the default accent is a plain color");
    await p.click("#btn-settings");
    await p.locator("#settings").waitFor();
    await p.click('#set-accent button[title="彩虹渐变"]');
    assert.ok(await p.isChecked("#set-accent-grad"), "a gradient ticks 渐变到");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.accent, "linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142, #51cf66, #4dabf7, #9775fa)", "saved");
    assert.match(await marker(), /linear-gradient/, "the active tab's line is the gradient");
    // 自定义的纯色
    await p.click("#btn-settings");
    assert.ok(await p.locator('#set-accent button.on[title="彩虹渐变"]').isVisible(), "the saved accent is marked");
    await p.uncheck("#set-accent-grad");
    await p.fill("#set-accent-from", "#123abc");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.accent, "#123abc", "a custom color");
    assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()), "#123abc");
    await p.click("#btn-settings");
    await p.click('#set-accent button[title="默认(橙色)"]');
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.accent, "", "back to the default");
    assert.equal(await marker(), "none");
  });

  ui("text can get a gradient color, saved as a background-clip span", { seed: seed({ "": { 页: "渐变" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+Home");
    await until(h.selection, "渐变");
    await p.click('#format-bar [data-cmd="color"]');
    await p.click('.fb-pop .fb-gradients [title="彩虹渐变"]');
    const md =
      '<span style="color: #ff5f6d; background-image: linear-gradient(90deg, #ff5f6d, #ffa94d, #f5d142, #51cf66, #4dabf7, #9775fa); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent">渐变</span>';
    assert.equal(await h.editor(), md);
    await until(() => h.mockFile("", "页"), md, "saved");
    await p.reload();
    await p.locator('#editor span[data-color^="linear-gradient"]').waitFor();
    assert.equal(await h.editor(), md, "read back the same after a restart");
  });
});
