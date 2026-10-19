// 界面测试:用 Playwright 在 Chromium 里打开 src/index.html,跑在浏览器预览用的模拟后端上(src/js/mock.js)。
// 运行:npm run test:ui(会先运行 scripts/prepare.mjs 复制 src/vendor 里的第三方库)
// 每个测试都用新的浏览器上下文(localStorage 是空的),窗口 440×540,页面报错或输出 console.error 都算失败。
import { after, before, describe as suite, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright";
import { serve } from "../scripts/serve.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
// 每个测试用自己的浏览器上下文,互不影响:同一组里的测试 4 个一起跑
const describe = (name, fn) => suite(name, { concurrency: 4 }, fn);
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
  ui_style: "classic", // 旧测试按原来的样子量尺寸和颜色;三种界面风格有自己的测试
  color_library_rev: 1, // 测试里的颜色库按最新内置颜色算，启动时不再补 0.3.11 的渐变
  material_library: [], // 旧测试只看纯色和渐变；材质色的测试自己放默认材质库
  block_context_menu: "block", // 既有块管理测试仍使用右键块菜单；实际默认改回系统右键
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

// 设置里换到某一类(设置分了类,只显示选中的那一类)
const settingsPage = (p, name) => p.click(`#set-nav [data-page="${name}"]`);
// 展开的颜色库里某一分区（quick / solid / gradient）的颜色，按显示顺序
const sectionColors = (library, kind) => library.locator(".uc-presets").evaluate((el, section) => {
  let active = "";
  return [...el.querySelectorAll(".uc-kind-title, .uc-preset")].flatMap((node) => {
    if (node.classList.contains("uc-kind-title")) { active = node.dataset.section; return []; }
    return active === section ? [node.dataset.color] : [];
  });
}, kind);
// 颜色库切到纯色 / 渐变 / 材质
const showKind = (p, root, kind) => p.click(`${root} .uc-kind[data-kind="${kind}"]`);
async function expandLibrary(p, selector) {
  const more = p.locator(selector + " .uc-more");
  if ((await more.getAttribute("aria-expanded")) === "false") await more.click();
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
  // url:打开别的网址(比如小窗 index.html?mini=1&book=&page=页)
  // mockControl:页面加载前放进 window.__mockControl;routes:{ 网址: 处理函数 },拦下这些网络请求
  const { seed: db, url = "/index.html", mockControl, routes = {} } = args[0] ?? {};
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
      if (mockControl) await ctx.addInitScript((c) => { window.__mockControl = c; }, mockControl);
      for (const [pattern, handler] of Object.entries(routes)) await ctx.route(pattern, handler);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => m.type() === "error" && errors.push(`console.error: ${m.text()}`));
      page.on("dialog", (d) => {
        dialogs.push(`${d.type()}: ${d.message()}`);
        d.dismiss().catch(() => {});
      });
      const h = helpers(page);
      h.dialogs = dialogs;
      await page.goto(base + url);
      // 标签收进侧拉列表时看不见,只等它们画出来
      await page.waitForSelector("#tabs .tab", { state: "attached" });
      await fn(h);
      // 不等防抖,马上把保存和 save_meta 跑完,它们出的错也要算上
      await page.evaluate(() => window.__minipad.flush());
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
    "sync: set to overwrite, on a conflict the unsaved local edit is kept, warned about and then saved",
    { seed: { ...seed({ "": { 待办: "外部改过的内容", 同步来的: "来自网盘" } }), settings: { ...SETTINGS, conflict_mode: "overwrite" } } },
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
      assert.deepEqual(await h.tabs(), ["待办", "同步来的"], "no conflict copy");
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
    await p.keyboard.press("Control+Shift+KeyF");
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

describe("notebook manager and window movement", () => {
  ui("topbar uses one colored icon, title reveals notebook name; manager remembers book appearance", {
    seed: seed({ "": { 欢迎: "默认内容" }, 工作: { 周报: "内容" } }),
  }, async (h) => {
    const { p } = h;
    assert.equal(await p.$eval("#btn-book", (b) => b.title), "默认");
    assert.equal(await p.isVisible("#book-icon svg"), true);
    const buttonSize = await p.$eval("#btn-book", (b) => Math.round(b.getBoundingClientRect().width));
    assert.equal(buttonSize, 32, "topbar keeps a 32px icon instead of notebook name");
    await h.openBooks();
    await p.click("#books-manage");
    assert.equal(await p.isVisible("#book-manager"), true);
    assert.equal(await p.isHidden("#books"), true);
    assert.equal(await p.isDisabled("#bm-rename"), true, "default notebook cannot be renamed");
    assert.equal(await p.isDisabled("#bm-delete"), true, "default notebook cannot be deleted");
    await p.click('#bm-list [data-book="工作"]');
    assert.equal(await p.textContent("#bm-selected"), "工作");
    await p.click('#bm-icons [data-icon="briefcase"]');
    await until(() => h.stored().then((db) => db.books["工作"].meta.icon), "briefcase");
    await expandLibrary(p, "#bm-details");
    await expandLibrary(p, "#bm-details .shared-colors");
    await p.click('#bm-details .uc-swatch[data-color="#3b82f6"]');
    await until(() => h.stored().then((db) => db.books["工作"].meta.icon_color), "#3b82f6");
    assert.equal(await p.$eval('#bm-list [data-book="工作"] svg', (el) => getComputedStyle(el).color), "rgb(59, 130, 246)");
    await p.click("#bm-close");
    await h.switchBook("工作");
    assert.equal(await p.$eval("#btn-book", (b) => b.title), "工作");
    assert.equal(await p.$eval("#book-icon svg", (e) => getComputedStyle(e).color), "rgb(59, 130, 246)");
    await p.reload();
    await until(h.bookName, "工作", "current notebook is restored");
    assert.equal(await p.$eval("#btn-book", (b) => b.title), "工作");
    assert.equal(await p.$eval("#book-icon svg", (e) => getComputedStyle(e).color), "rgb(59, 130, 246)");
    assert.equal(await h.mockFile("工作", "周报"), "内容", "changing icon does not touch notebook pages");
  });

  ui("manager lets users set custom colors, rename and keep icon metadata", {
    seed: seed({ "": { 首页: "Welcome" }, 旅行: { 清单: "passport" } }),
  }, async (h) => {
    const { p } = h;
    await h.openBooks();
    await p.click("#books-manage");
    await p.click('#bm-list [data-book="旅行"]');
    await p.click('#bm-icons [data-icon="heart"]');
    await until(() => h.stored().then((db) => db.books["旅行"].meta.icon), "heart");
    await expandLibrary(p, "#bm-details .shared-colors");
    const customEditor = p.locator("#bm-details .shared-colors");
    await customEditor.locator(".uc-actions button").first().click();
    await customEditor.locator('input[aria-label="节点 1 颜色"]').fill("#1122aa");
    await customEditor.locator(".uc-editor .uc-actions .primary").click();
    await until(() => h.stored().then((db) => db.books["旅行"].meta.icon_color), "#1122aa");
    await p.click("#bm-rename");
    await h.answer("旅途");
    await until(() => h.stored().then((db) => db.books["旅途"]?.meta.icon), "heart");
    assert.equal(await h.mockFile("旅途", "清单"), "passport");
    assert.equal(await p.$eval('#bm-list [data-book="旅途"] svg', (el) => getComputedStyle(el).color), "rgb(17, 34, 170)");
    await p.press("#bm-close", "Escape");
    assert.equal(await p.isHidden("#book-manager"), true, "Escape closes manager before hiding the app");
  });

  ui("notebook gradients render on actual icons, and presets persist and work across notebooks", {
    seed: seed({ "": { 首页: "welcome" }, 工作: { 文档: "work" }, 生活: { 清单: "life" } }),
  }, async (h) => {
    const { p } = h;
    await h.openBooks();
    await p.click("#books-manage");
    await p.click('#bm-list [data-book="工作"]');
    const gradient = "linear-gradient(135deg, #5fb4ff, #d66cf0)";
    await expandLibrary(p, "#bm-details");
    await expandLibrary(p, "#bm-details .shared-colors");
    await showKind(p, "#bm-details", "gradient");
    await p.click('#bm-details .uc-swatch[data-color="' + gradient + '"]');
    await until(() => h.stored().then((db) => db.books["工作"].meta.icon_color), gradient);
    const strokes = await p.$eval('#bm-list [data-book="工作"] svg', (svg) => ({
      gradient: svg.querySelectorAll("linearGradient stop").length,
      stroke: svg.getAttribute("style"),
    }));
    assert.equal(strokes.gradient, 2, "gradient icon has actual SVG color stops");
    assert.match(strokes.stroke, /url\(#book-icon-gradient-/, "icon uses SVG gradient stroke");
    await expandLibrary(p, "#bm-details .shared-colors");
    await p.click("#bm-details .shared-colors > .uc-actions button >> nth=1");
    assert.ok(await p.locator('#bm-details .uc-swatch[data-color="' + gradient + '"]').isVisible(), "built-in gradient exists in shared library");
    await p.click('#bm-list [data-book="生活"]');
    await expandLibrary(p, "#bm-details");
    await expandLibrary(p, "#bm-details .shared-colors");
    await p.click('#bm-details .uc-swatch[data-color="' + gradient + '"]');
    await until(() => h.stored().then((db) => db.books["生活"].meta.icon_color), gradient);
    await p.reload();
    await h.openBooks();
    await p.click("#books-manage");
    await expandLibrary(p, "#bm-details .shared-colors");
    assert.ok(await p.locator('#bm-details .uc-swatch[data-color="' + gradient + '"]').isVisible(), "colors survive restart");
    await expandLibrary(p, "#bm-details .shared-colors");
    // 它是渐变快捷色：先移出快捷栏，再在渐变色库里删掉
    for (const step of ["out of quick", "built-in colors can be removed"]) {
      await p.locator('#bm-details .uc-swatch[data-color="' + gradient + '"]').hover();
      await p.locator('#bm-details .uc-swatch[data-color="' + gradient + '"]').locator("..").locator(".uc-delete").click();
      await until(async () => step === "out of quick"
        ? !(await h.stored()).settings.quick_colors.includes(gradient)
        : !(await h.stored()).settings.color_library.includes(gradient), true, step);
    }
    assert.equal(await h.stored().then((db) => db.books["工作"].meta.icon_color), gradient, "removing preset keeps existing book colors");
    assert.equal(await h.mockFile("工作", "文档"), "work", "no note files changed");
  });

  ui("custom two-color gradient can be saved; selected swatches use a light theme outline", {
    seed: seed({ "": { 首页: "welcome" }, 设计: { 草稿: "notes" } }),
  }, async (h) => {
    const { p } = h;
    await h.openBooks();
    await p.click("#books-manage");
    await p.click('#bm-list [data-book="设计"]');
    await expandLibrary(p, "#bm-details .shared-colors");
    const solid = p.locator('#bm-details .uc-swatch[data-color="#3b82f6"]');
    await solid.click();
    const outline = await solid.evaluate((el) => {
      const style = getComputedStyle(el);
      return { outline: style.outlineWidth, border: style.borderTopWidth };
    });
    assert.equal(outline.outline, "1px", "thin selection outline");
    assert.equal(outline.border, "1px", "thin swatch border");
    await expandLibrary(p, "#bm-details .shared-colors");
    const editor = p.locator("#bm-details .shared-colors");
    await editor.locator(".uc-actions button").first().click();
    await editor.locator("select").selectOption("gradient");
    await editor.locator('input[aria-label="节点 2 颜色"]').fill("#abcdef");
    await editor.locator(".uc-editor .uc-actions .primary").click();
    const custom = "linear-gradient(135deg, #3b82f6 0%, #abcdef 100%)";
    await until(() => h.stored().then((db) => db.books["设计"].meta.icon_color), custom);
    await editor.locator(":scope > .uc-actions button").nth(1).click();
    await until(async () => (await h.stored()).settings.color_library?.includes(custom), true);
    await editor.locator(":scope > .uc-actions button").nth(1).click();
    assert.equal((await h.stored()).settings.color_library.filter((c) => c === custom).length, 1, "duplicate presets are ignored");
  });

  ui("manager refuses invalid native save and does not change local icon", {
    seed: seed({ "": { 主页: "a" }, 工作: { 日志: "b" } }),
  }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { fail: { set_book_appearance: "拒绝写入" } }; });
    await h.openBooks();
    await p.click("#books-manage");
    await p.click('#bm-list [data-book="工作"]');
    await p.click('#bm-icons [data-icon="star"]');
    await until(() => p.textContent("#bm-error"), "保存图标失败：Error: 拒绝写入");
    assert.equal(await h.stored().then((db) => db.books["工作"].meta.icon || ""), "");
    assert.equal(await p.$eval('#bm-icons [data-icon="book"]', (b) => b.getAttribute("aria-checked")), "true");
  });

  ui("free status bar and Alt+left click allow native window dragging without editing", async (h) => {
    const { p } = h;
    assert.equal(await p.getAttribute('#status > .spacer', "data-tauri-drag-region"), "");
    assert.equal(await p.getAttribute("#status", "data-tauri-drag-region"), "");
    await p.evaluate(() => { window.__mockControl = { dragStarted: 0, calls: [] }; });
    await p.$eval("#editor", (el) => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    });
    assert.equal(await p.evaluate(() => window.__mockControl.dragStarted), 0, "normal clicks remain unchanged");
    await p.$eval("#editor", (el) => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, altKey: true, button: 0 }));
    });
    await until(() => p.evaluate(() => window.__mockControl.dragStarted), 1, "Alt-click triggers native drag");
    await p.click("#btn-settings");
    await p.$eval("#set-hotkey", (el) => {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, altKey: true, button: 0 }));
    });
    assert.equal(await p.evaluate(() => window.__mockControl.dragStarted), 1, "modal controls do not trigger drag");
  });
});

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
          ["pin", "固定标签"],
          ["move", "移到笔记本…"],
          ["mini-open", "在小窗中打开"],
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
      await p.keyboard.press("Control+Shift+KeyF");
      await p.locator("#search-input").waitFor();
      await p.keyboard.type("关键字");
      await until(where, ["工作 › 周报 · 第 2 行"], "the result shows the notebook label");
      await p.keyboard.press("Enter");
      await until(h.bookName, "工作", "opening the result switches notebook");
      await until(h.activeTab, "周报");
      await until(h.selection, "关键字", "the match is selected");

      await p.keyboard.press("Control+Shift+KeyF");
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
    await settingsPage(p, "data");
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
    await settingsPage(p, "data");
    await p.locator("#settings").waitFor();
    assert.equal(await p.inputValue("#set-backup-keep"), "365");
    assert.equal(await p.inputValue("#set-backup-dir"), "D:\\笔记备份");
    await p.fill("#set-backup-keep", "-5");
    await p.uncheck("#set-backup");
    await p.click("#set-save");
    await until(saved, [false, 1, "D:\\笔记备份"], "keep is clamped to 1, backup off");

    await p.click("#btn-settings");
    await settingsPage(p, "data");
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
    await settingsPage(p, "edit");
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
    await p.keyboard.press("Control+Shift+KeyF");
    await p.locator("#search").waitFor();
    await p.keyboard.press("F5");
    await p.keyboard.press("Escape");
    assert.equal(await h.editor(), today, "nothing inserted from the search box");
    assert.equal(await p.evaluate(() => window.__notReloaded), true, "F5 never reloads the page");
  });

  ui("set to show only with the format bar hidden, a toolbar formats selected text; Ctrl+B bolds a selection and opens the notebooks without one", { seed: { ...seed({ "": { 页: "一段文字" } }), settings: { ...SETTINGS, sel_bar: "nobar" } } }, async (h) => {
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
    // 无界面的 Chromium 偶尔会吞掉紧跟在 Ctrl+B 后面的 End（选区还是链接文字），没取消选中就再按一次
    await until(async () => {
      await p.keyboard.press("End");
      return h.selection();
    }, "", "nothing selected");
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

// ---------- 顶层块管理 ----------

describe("block management", () => {
  ui("right-click inserts a paragraph below a trailing code block and converts it to a heading", {
    seed: seed({ "": { 页: "~~~js\nconsole.log(1)\n~~~" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click({ button: "right" });
    assert.ok(await p.locator('#ctx button[data-act="block-insert-after"]').isVisible());
    await p.click('#ctx button[data-act="block-insert-after"]');
    await p.click('#ctx button[data-act="block-type-paragraph"]');
    await p.keyboard.type("下一段");
    assert.equal(await p.locator("#editor .ProseMirror > p").last().textContent(), "下一段");
    assert.equal(await p.locator("#editor .codeblock code").textContent(), "console.log(1)");
    await p.locator("#editor .ProseMirror > p").last().click({ button: "right" });
    await p.click('#ctx button[data-act="block-convert"]');
    await p.click('#ctx button[data-act="block-type-heading2"]');
    assert.equal(await p.locator("#editor .ProseMirror > h2").textContent(), "下一段");
    assert.match(await h.editor(), /## 下一段$/, "converted heading is stored in Markdown");
    await until(async () => (await h.mockFile("", "页")).includes("## 下一段"), true,
      "converted heading is saved");
  });

  ui("drag, duplicate, delete and undo manage whole Markdown blocks", {
    seed: seed({ "": { 页: "甲\n\n乙\n\n丙" } }),
  }, async (h) => {
    const { p } = h;
    const blocks = p.locator("#editor .ProseMirror > p");
    await blocks.first().hover();
    assert.ok(await p.locator(".block-handle").isVisible(), "hover shows a grab handle");
    const lastBox = await blocks.last().boundingBox();
    await p.locator(".block-handle").dragTo(blocks.last(), {
      targetPosition: { x: lastBox.width / 2, y: lastBox.height - 2 },
    });
    await until(h.editor, "乙\n\n丙\n\n甲", "drag moves a paragraph below the last block");

    await blocks.last().click({ button: "right" });
    await p.click('#ctx button[data-act="block-duplicate"]');
    await until(h.editor, "乙\n\n丙\n\n甲\n\n甲", "duplicate copies the complete block");

    await blocks.last().click({ button: "right" });
    await p.click('#ctx button[data-act="block-delete"]');
    await until(h.editor, "乙\n\n丙\n\n甲", "delete removes just the target block");
    await p.keyboard.press("Control+z");
    await until(h.editor, "乙\n\n丙\n\n甲\n\n甲", "Ctrl+Z restores deleted block");
  });

  ui("blocks can convert among text, quote, list and code without losing their text", {
    seed: seed({ "": { 页: "保留这段文字" } }),
  }, async (h) => {
    const { p } = h;
    const convert = async (kind) => {
      await p.locator("#editor .ProseMirror > :first-child").click({ button: "right" });
      // 右键会优先选中嵌套块；需要操作整个引用块时明确进入外层菜单。
      const outer = p.locator('#ctx button[data-act="block-outer"]');
      if (await outer.isVisible()) await outer.click();
      await p.click('#ctx button[data-act="block-convert"]');
      await p.click('#ctx button[data-act="block-type-' + kind + '"]');
    };
    await convert("blockquote");
    assert.equal(await p.locator("#editor blockquote").textContent(), "保留这段文字");
    assert.equal(await p.locator("#editor .ProseMirror > blockquote").count(), 1);
    await convert("bullet_list");
    assert.equal(await p.locator("#editor ul > li").textContent(), "保留这段文字");
    assert.equal(await p.locator("#editor .ProseMirror > ul").count(), 1);
    await convert("code_block");
    assert.equal(await p.locator("#editor .codeblock code").textContent(), "保留这段文字");
    assert.equal(await p.locator("#editor .ProseMirror > .codeblock").count(), 1,
      "converting a single-item list places the code block at the document root");

    await p.locator("#editor .codeblock code").click({ button: "right" });
    await p.click('#ctx button[data-act="block-insert-before"]');
    await p.click('#ctx button[data-act="block-type-paragraph"]');
    assert.equal(await p.locator("#editor .ProseMirror > p").count(), 1,
      "insert-before creates a top-level paragraph");
    await p.keyboard.type("前面的正文");
    assert.equal(await p.locator("#editor .ProseMirror > p").first().textContent(), "前面的正文");
    assert.equal(await p.locator("#editor .codeblock code").textContent(), "保留这段文字");
  });
});

// ---------- 第二阶段：折叠、嵌套与表格 ----------

describe("advanced blocks", () => {
  ui("folded Markdown persists its title, children and collapsed state", {
    seed: seed({ "": { 页: "> [!fold]- 课件总结\n>\n> 第一段\n>\n> - 清单\n>\n> 第二段" } }),
  }, async (h) => {
    const { p } = h;
    const fold = p.locator("#editor .fold-block").first();
    await fold.waitFor();
    assert.equal(await fold.locator(".fold-title").textContent(), "课件总结");
    assert.equal(await fold.locator(".fold-toggle").getAttribute("aria-expanded"), "false");
    assert.ok(await fold.locator("ul").isHidden(), "collapsed children are hidden");
    await fold.locator(".fold-toggle").click();
    assert.ok(await fold.locator("ul").isVisible(), "expanding reveals nested Markdown blocks");
    await until(async () => (await h.editor()).includes("[!fold]+ 课件总结"), true,
      "expanded state is stored as Markdown");
    await p.reload();
    const restored = p.locator("#editor .fold-block").first();
    assert.equal(await restored.locator(".fold-toggle").getAttribute("aria-expanded"), "true");
    assert.ok(await restored.locator("ul").isVisible());
    await restored.locator(".fold-title").click();
    await p.locator("#dialog-input").fill("新标题");
    await p.locator("#dialog-ok").click();
    await until(async () => (await h.editor()).includes("[!fold]+ 新标题"), true, "title persists");
  });

  ui("turning a multi-block quote into a fold preserves all child blocks", {
    seed: seed({ "": { 页: "> 段落甲\n>\n> - 列表甲\n>\n> 段落乙" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor blockquote li").first().click({ button: "right" });
    await p.click('#ctx button[data-act="block-outer"]');
    await p.click('#ctx button[data-act="block-convert"]');
    await p.click('#ctx button[data-act="block-type-fold"]');
    assert.equal(await p.locator("#editor .fold-block > ul li").textContent(), "列表甲");
    assert.equal(await p.locator("#editor .fold-block > p").count(), 3);
    assert.ok((await h.editor()).includes("[!fold]+ 折叠块"), "converted block has a Markdown marker");
    await p.locator("#editor .fold-block .fold-title").click();
    await p.click("#dialog-cancel");
    await p.locator("#editor .fold-heading").click({ button: "right" });
    await p.click('#ctx button[data-act="block-convert"]');
    assert.ok(await p.locator('#ctx button[data-act="block-type-paragraph"]').isDisabled(),
      "multi-child fold cannot be destructively flattened");
    await p.click('#ctx button[data-act="block-type-blockquote"]');
    assert.equal(await p.locator("#editor blockquote > ul li").textContent(), "列表甲");
    assert.ok(!(await h.editor()).includes("[!fold]"), "convert to quote removes marker");
  });

  ui("block menu inserts an editable table without changing nearby code", {
    seed: seed({ "": { 页: "~~~js\nconsole.log(1)\n~~~" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click({ button: "right" });
    await p.click('#ctx button[data-act="block-insert-after"]');
    await p.click('#ctx button[data-act="block-type-table"]');
    assert.equal(await p.locator("#editor table tr").count(), 3);
    assert.equal(await p.locator("#editor table tr").first().locator("th").count(), 3);
    assert.equal(await p.locator("#editor .codeblock code").textContent(), "console.log(1)");
  });
});

describe("nested drag and complex tables", () => {
  ui("dragging individual list items changes their order and supports indent/outdent", {
    seed: seed({ "": { 页: "- 第一\n- 第二\n- 第三" } }),
  }, async (h) => {
    const { p } = h;
    const list = p.locator("#editor .ProseMirror > ul > li");
    await list.first().hover();
    assert.ok(await p.locator(".block-handle").isVisible(), "nested list item has a handle");
    const box = await list.last().boundingBox();
    await p.locator(".block-handle").dragTo(list.last(), {
      targetPosition: { x: box.width / 2, y: box.height - 2 },
    });
    await until(async () => list.allTextContents(), ["第二", "第三", "第一"], "reorder list items");
    await list.last().click({ button: "right" });
    await p.click('#ctx button[data-act="block-indent"]');
    assert.equal(await p.locator("#editor ul ul > li").textContent(), "第一");
    await p.locator("#editor ul ul > li").click({ button: "right" });
    await p.click('#ctx button[data-act="block-outdent"]');
    await until(async () => list.allTextContents(), ["第二", "第三", "第一"], "outdent restores sibling");
    await until(async () => (await h.mockFile("", "页")).includes("第一"), true, "nested edits save");
  });

  ui("a paragraph can be dragged into a fold and moved back out without losing text", {
    seed: seed({ "": { 页: "> [!fold]+ 学习资料\n>\n> 里面\n\n外部" } }),
  }, async (h) => {
    const { p } = h;
    const external = p.locator("#editor .ProseMirror > p").last();
    await external.hover();
    await p.locator(".block-handle").dragTo(p.locator("#editor .fold-heading"));
    await until(async () => p.locator("#editor .fold-block > p").allTextContents(),
      ["[!fold]+ 学习资料", "里面", "外部"], "cross-level drop moves the whole paragraph into a fold");
    await p.locator("#editor .fold-block > p").last().click({ button: "right" });
    await p.click('#ctx button[data-act="block-outdent"]');
    await until(async () => p.locator("#editor .ProseMirror > p").last().textContent(),
      "外部", "outdent moves the paragraph back to the document");
    assert.ok((await h.editor()).includes("[!fold]+ 学习资料"), "fold metadata survives movement");
  });

  ui("table rows and columns can be inserted, duplicated, deleted and undone", {
    seed: seed({ "": { 页: "| A | B |\n| --- | --- |\n| 1 | 2 |" } }),
  }, async (h) => {
    const { p } = h;
    const table = p.locator("#editor table");
    await table.locator("tr").last().locator("td").first().click({ button: "right" });
    await p.click('#ctx button[data-act="block-table-col-right"]');
    assert.equal(await table.locator("tr").first().locator("th").count(), 3);
    assert.equal(await table.locator("tr").last().locator("td").count(), 3);
    await table.locator("tr").last().locator("td").first().click({ button: "right" });
    await p.click('#ctx button[data-act="block-table-row-below"]');
    assert.equal(await table.locator("tr").count(), 3);
    await table.locator("tr").last().locator("td").first().click({ button: "right" });
    await p.click('#ctx button[data-act="block-table-row-duplicate"]');
    assert.equal(await table.locator("tr").count(), 4);
    await table.locator("tr").last().locator("td").first().click({ button: "right" });
    await p.click('#ctx button[data-act="block-table-row-delete"]');
    assert.equal(await table.locator("tr").count(), 3);
    await p.keyboard.press("Control+z");
    await until(async () => table.locator("tr").count(), 4, "undo restores deleted row");
    await until(async () => (await h.editor()).includes("| A |"), true, "GFM table still serializes");
    await p.reload();
    assert.equal(await p.locator("#editor table tr").count(), 4, "table structure survives reload");
  });
});


describe("block editor review regressions", () => {
  ui("Ctrl+End and clicking below a closed final fold append text after it", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]- 标题\n>\n> 隐藏内容" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+End");
    await p.keyboard.type("Z");
    assert.equal(await p.locator("#editor .ProseMirror > p").last().textContent(), "Z", await h.editor());
    assert.equal(await p.locator("#editor .ProseMirror > p").first().textContent(), "前文");
    await p.keyboard.press("Control+z");
    const box = await p.locator("#editor .ProseMirror > blockquote.fold-closed").boundingBox();
    const area = await p.locator("#editor").boundingBox();
    await p.mouse.click(area.x + area.width / 2, Math.min(area.y + area.height - 5, box.y + box.height + 12));
    await p.keyboard.type("B");
    assert.equal(await p.locator("#editor .ProseMirror > p").last().textContent(), "B");
    assert.equal(await p.locator("#editor .ProseMirror > p").first().textContent(), "前文");
  });

  ui("read-only folds expand without changing the document or file", {
    seed: seed({ "": { 页: "> [!fold]- 标题\n>\n> 隐藏内容" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.mockFile("", "页");
    await p.evaluate(() => {
      window.__mockControl = { unreadable: { "": { 页: "模拟读取失败" } },
        keepUnreadableContent: true, calls: [] };
    });
    await h.sync();
    await until(async () => p.locator(".tab.unreadable").count(), 1, "unreadable page remains open");
    assert.equal(await p.getAttribute("#editor .ProseMirror", "contenteditable"), "false");
    const fold = p.locator("#editor blockquote.fold-block");
    assert.equal(await fold.locator(".fold-toggle").getAttribute("aria-expanded"), "false");
    await fold.locator(".fold-toggle").click();
    assert.equal(await fold.locator(".fold-toggle").getAttribute("aria-expanded"), "true");
    assert.ok(await fold.getByText("隐藏内容").isVisible());
    assert.equal(await h.mockFile("", "页"), before);
  });

  ui("system right-click and block manager off both preserve ordinary editing", {
    seed: { ...seed({ "": { 页: "正常正文" } }), settings: { ...SETTINGS,
      block_context_menu: "system", block_enabled: false } },
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click({ button: "right" });
    assert.ok(await p.locator("#ctx").isHidden(), "system context menu is not intercepted");
    await p.locator("#editor .ProseMirror > p").hover();
    assert.ok(await p.locator(".block-handle").isHidden(), "no block handle when disabled");
    const padding = await p.locator("#editor .ProseMirror").evaluate((el) => getComputedStyle(el).paddingLeft);
    assert.equal(padding, "14px", "original editor margin restored");
    await p.locator("#editor .ProseMirror > p").click();
    await p.keyboard.press("Control+End");
    await p.keyboard.type("继续");
    assert.equal(await h.editor(), "正常正文继续");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.isChecked("#set-block-enabled"), false);
    await p.check("#set-block-enabled");
    await p.click("#set-save");
    await p.locator("#editor .ProseMirror > p").hover();
    assert.ok(await p.locator(".block-handle").isVisible(), "turning blocks on restores handle");
    await p.locator(".block-handle").click();
    assert.ok(await p.locator('#ctx button[data-act="block-insert-after"]').isVisible());
  });

  ui("three-Enter code exit preserves a blank line during coding", {
    seed: seed({ "": { 页: "```python\ndef a():\n    pass\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    await p.keyboard.press("Control+End");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    await p.keyboard.type("def b():");
    assert.equal(await p.locator("#editor .codeblock code").textContent(),
      "def a():\n    pass\n\ndef b():");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    await p.keyboard.type("正文");
    assert.equal(await p.locator("#editor .ProseMirror > p").last().textContent(), "正文");
  });

  ui("find reveals closed folds and serialized markers have no backslash", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]- 标题\n>\n> 秘密内容" } }),
  }, async (h) => {
    const { p } = h;
    const fold = p.locator("#editor blockquote.fold-block");
    await fold.locator(".fold-toggle").click();
    await until(async () => (await h.mockFile("", "页")).includes("> [!fold]+ 标题"), true,
      "serialized fold marker is unescaped");
    assert.equal(await h.mockFile("", "页"), "前文\n\n> [!fold]+ 标题\n>\n> 秘密内容",
      "the complete saved Markdown preserves the unescaped fold marker");
    await fold.locator(".fold-toggle").click();
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+f");
    await p.fill("#find-input", "秘密");
    await until(async () => fold.locator(".fold-toggle").getAttribute("aria-expanded"), "true",
      "searching hidden content reveals its fold");
  });

  ui("table handle hides cell operations; header actions are disabled", {
    seed: seed({ "": { 页: "| A | B |\n| --- | --- |\n| 1 | 2 |" } }),
  }, async (h) => {
    const { p } = h;
    const table = p.locator("#editor table");
    await table.locator("td").last().hover();
    await p.locator(".block-handle").click();
    assert.equal(await p.locator('#ctx button[data-act="block-table-col-delete"]').count(), 1,
      "handle menu targets the last hovered table cell");
    await p.click("#editor .ProseMirror");
    await table.locator("th").first().click({ button: "right" });
    assert.equal(await p.locator('#ctx button[data-act="block-table-row-delete"]').isDisabled(), true);
    assert.equal(await p.locator('#ctx button[data-act="block-table-row-above"]').isDisabled(), true);
  });

  ui("a fold cannot convert into itself and can disable persistence", {
    seed: { ...seed({ "": { 页: "> [!fold]- 标题\n>\n> 隐藏内容" } }), settings: { ...SETTINGS, fold_save_state: false } },
  }, async (h) => {
    const { p } = h;
    const fold = p.locator("#editor blockquote.fold-block");
    const before = await h.mockFile("", "页");
    await fold.locator(".fold-toggle").click();
    assert.equal(await fold.locator(".fold-toggle").getAttribute("aria-expanded"), "true");
    assert.equal(await h.mockFile("", "页"), before, "UI-only unfolding leaves file unchanged");
    await fold.locator(".fold-heading").click({ button: "right" });
    await p.click('#ctx button[data-act="block-convert"]');
    assert.equal(await p.locator('#ctx button[data-act="block-type-fold"]').isDisabled(), true);
  });
});

describe("fold boundary safety", () => {
  ui("collapse followed by typing preserves the entire fold", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]+ 标题\n>\n> 内容\n\n后文" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .fold-block > p").last().click();
    await p.locator("#editor .fold-toggle").click();
    await p.keyboard.type("Z");
    assert.ok((await h.editor()).includes("> 内容"), "the fold contents must survive");
    assert.ok((await h.editor()).includes("[!fold]- 标题"), "the fold marker must survive");
    assert.ok((await h.editor()).includes("Z后文"), "typing goes into the following visible text");
  });

  ui("Backspace and Delete cannot corrupt fold boundaries", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]- 标题\n>\n> 隐藏内容\n\n后文" } }),
  }, async (h) => {
    const { p } = h;
    const original = await h.editor();
    await p.locator("#editor .ProseMirror > p").last().click();
    await p.keyboard.press("Home");
    await p.keyboard.press("Backspace");
    assert.equal(await h.editor(), original, "Backspace leaves preceding fold intact");
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("End");
    await p.keyboard.press("Delete");
    assert.equal(await h.editor(), original, "Delete cannot pull the marker outside the fold");
    await p.locator("#editor .fold-toggle").click();
    await p.locator("#editor .fold-block > p").last().click();
    await p.keyboard.press("Home");
    const expanded = await h.editor();
    await p.keyboard.press("Backspace");
    assert.equal(await h.editor(), expanded, "first visible content cannot join hidden marker");
  });
});

describe("nested fold cursor", () => {
  ui("Ctrl+End after a nested closed fold leaves file unchanged until typing", {
    seed: seed({ "": { 页: "前文\n\n> 外层\n>\n> > [!fold]- 内层\n> >\n> > 隐藏内容" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.mockFile("", "页");
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+End");
    await sleep(350);
    assert.equal(await h.mockFile("", "页"), before, "cursor navigation should not save");
    await p.keyboard.type("Z");
    assert.equal(await p.locator("#editor .ProseMirror > p").last().textContent(), "Z");
    assert.equal(await p.locator("#editor .ProseMirror > p").first().textContent(), "前文");
    assert.ok((await h.editor()).includes("[!fold]- 内层"));
  });

  ui("fold serialization preserves nested marker and code backslash", {
    seed: seed({ "": { 页: "> 外层\n>\n> > [!fold]- 内层\n> >\n> > 内容\n\n~~~text\n> \\[!fold]+ 示例\n~~~" } }),
  }, async (h) => {
    const { p } = h;
    assert.ok(await p.locator("#editor .fold-toggle").count(),
      JSON.stringify(await p.evaluate(() => window.__minipad.editor().view.state.doc.toJSON())));
    await p.locator("#editor .fold-toggle").click();
    const md = await h.editor();
    assert.ok(md.includes("> > [!fold]+ 内层"), "nested marker is not escaped");
    assert.ok(md.includes("> \\[!fold]+ 示例"), "code backslash remains intact");
    await until(async () => (await h.mockFile("", "页")).includes("> > [!fold]+ 内层"), true);
    await p.reload();
    assert.equal(await p.locator("#editor .fold-toggle").getAttribute("aria-expanded"), "true");
  });
});

describe("fold menus and tables", () => {
  ui("find expansion, collapse and re-expansion work on the first click", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]- 标题\n>\n> 秘密内容\n\n后文" } }),
  }, async (h) => {
    const { p } = h;
    const fold = p.locator("#editor .fold-block");
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+f");
    await p.fill("#find-input", "秘密");
    await until(async () => fold.locator(".fold-toggle").getAttribute("aria-expanded"), "true");
    await p.keyboard.press("Escape");
    await fold.locator(".fold-toggle").click();
    assert.equal(await fold.locator(".fold-toggle").getAttribute("aria-expanded"), "false");
    await fold.locator(".fold-toggle").click();
    assert.equal(await fold.locator(".fold-toggle").getAttribute("aria-expanded"), "true");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    await p.uncheck("#set-fold-save");
    await p.click("#set-save");
    await fold.locator(".fold-toggle").click();
    await fold.locator(".fold-title").click();
    await p.fill("#dialog-input", "新标题");
    await p.click("#dialog-ok");
    assert.ok((await h.editor()).includes("[!fold]+ 新标题"),
      "renaming preserves the saved state instead of the temporary collapsed state");
  });

  ui("table handle uses hovered column under default system menu", {
    seed: { ...seed({ "": { 页: "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |" } }),
      settings: { ...SETTINGS, block_context_menu: "system" } },
  }, async (h) => {
    const { p } = h;
    const table = p.locator("#editor table");
    await table.locator("td").nth(1).hover();
    await p.locator(".block-handle").click();
    assert.ok(await p.locator('#ctx button[data-act="block-table-col-delete"]').isVisible());
    await p.click('#ctx button[data-act="block-table-col-delete"]');
    assert.deepEqual(await table.locator("th").allTextContents(), ["A", "C"]);
  });
});

describe("fold edge regressions", () => {
  ui("undo inside a fold after collapsing never mismatches transactions", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]+ 标题\n>\n> 内容\n\n后文" } }),
  }, async ({ p, editor }) => {
    const content = p.locator("#editor .fold-block > p").last();
    await content.click();
    await p.keyboard.press("End");
    await p.keyboard.type("X");
    assert.ok((await editor()).includes("内容X"));
    await p.locator(".fold-toggle").click();
    await p.keyboard.press("Control+z");
    assert.ok(!(await editor()).includes("内容X"), "the latest text edit is undone");
    assert.ok((await editor()).includes("[!fold]- 标题"), "fold remains intact");
  });

  ui("external sync collapsing edited content does not discard the incoming version", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]+ 标题\n>\n> 内容\n\n后文" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .fold-block > p").last().click();
    await p.evaluate(() => { window.__mockFiles["页"] = "前文\n\n> [!fold]- 标题\n>\n> 内容改\n\n后文"; });
    await h.sync();
    await until(async () => (await h.editor()).includes("内容改"), true, "incoming edited content is displayed");
    assert.ok((await h.editor()).includes("[!fold]- 标题"));
    await p.keyboard.type("Z");
    assert.ok((await h.editor()).includes("内容改"), "typing never discards the external edit");
  });

  ui("fold boundary protects list and quote starts from Backspace", {
    seed: seed({ "": {
      列表: "前文\n\n> [!fold]- 标题\n>\n> 隐藏内容\n\n- 列表项",
      引用: "前文\n\n> [!fold]- 标题\n>\n> 隐藏内容\n\n> 普通引用",
    } }),
  }, async (h) => {
    const { p } = h;
    const listBefore = await h.editor();
    await p.locator("#editor .ProseMirror > ul li p").first().click();
    await p.keyboard.press("Home");
    await p.keyboard.press("Backspace");
    assert.equal(await h.editor(), listBefore, "the preceding closed fold remains intact");
    await h.tab("引用").click();
    const quoteBefore = await h.editor();
    await p.locator("#editor .ProseMirror > blockquote:not(.fold-block) p").first().click();
    await p.keyboard.press("Home");
    await p.keyboard.press("Backspace");
    assert.equal(await h.editor(), quoteBefore, "the closed fold is not merged into a quote");
  });

  ui("Delete between adjacent folds never merges marker paragraphs", {
    seed: seed({ "": { 页: "> [!fold]+ 一\n>\n> 内容一\n\n> [!fold]- 二\n>\n> 内容二" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .fold-block").first().locator("p").last().click();
    await p.keyboard.press("End");
    const before = await h.editor();
    await p.keyboard.press("Delete");
    assert.equal(await h.editor(), before);
    assert.equal(await p.locator(".fold-block").count(), 2);
  });

  ui("fold without a title stays untitled and writes after the visible next paragraph", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]+\n>\n> 内容\n\n后文" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .fold-block > p").last().click();
    await p.locator(".fold-toggle").click();
    await p.keyboard.type("Z");
    assert.ok((await h.editor()).includes("[!fold]-\n"), "the original empty title is preserved");
    assert.ok(!(await h.editor()).includes("[!fold]- 折叠块"), "no default title is inserted");
    assert.ok((await h.editor()).includes("Z后文"), "typing continues at the following paragraph");
  });

  ui("Ctrl+End uses an actual position for paste and find after a closed final fold", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]- 标题\n>\n> 内容" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.mockFile("", "页");
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+End");
    await sleep(400);
    assert.equal(await h.mockFile("", "页"), before, "navigation does not persist an empty paragraph");
    await p.keyboard.insertText("粘贴内容");
    assert.ok((await h.editor()).endsWith("粘贴内容"));
    assert.ok((await h.editor()).includes("[!fold]- 标题"));
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+End");
    await p.keyboard.press("Control+f");
    await p.fill("#find-input", "前文");
    await p.keyboard.press("Escape");
    await p.keyboard.type("X");
    assert.ok(!(await h.editor()).startsWith("X前文"), "find resets the navigation cursor");
  });

  ui("IME composition at the document end does not leave stray Latin letters", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]- 标题\n>\n> 内容" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+End");
    const cdp = await p.context().newCDPSession(p);
    try {
      await cdp.send("Input.imeSetComposition", {
        text: "zhong", selectionStart: 5, selectionEnd: 5,
      });
      await cdp.send("Input.insertText", { text: "中文" });
    } finally { await cdp.detach(); }
    const md = await h.editor();
    assert.ok(md.endsWith("中文"), md);
    assert.ok(!md.includes("z中文"), "IME initial composition letter must not leak");
  });

  ui("email auto-link setting also refreshes previously opened pages", {
    seed: seed({ "": { 甲: "name@example.com", 乙: "other@example.com" } }),
  }, async ({ p }) => {
    assert.equal(await p.locator("#editor .ProseMirror a").count(), 0);
    await p.locator("#tabs .tab").nth(1).click();
    assert.equal(await p.locator("#editor .ProseMirror a").count(), 0);
    await p.locator("#tabs .tab").first().click();
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    await p.check("#set-email-links");
    await p.click("#set-save");
    await until(() => p.locator("#editor .ProseMirror a").count(), 1);
    await p.locator("#tabs .tab").nth(1).click();
    await until(() => p.locator("#editor .ProseMirror a").count(), 1,
      "switching back uses the latest email parsing setting");
  });

  ui("read error alert shows all text in narrow windows and can be copied", {
    seed: seed({ "": { "2026年10月 项目周报（草稿）": "内容" } }),
  }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { unreadable: { "": {
      "2026年10月 项目周报（草稿）": "读取失败：原文件有无法转换的内容，建议先备份再修复，请勿覆盖原文件。"
    } }, keepUnreadableContent: true }; });
    await h.sync();
    await until(() => p.isVisible("#read-error"), true);
    const sizes = await p.locator("#read-error").evaluate((el) => ({
      scroll: el.scrollHeight, visible: el.clientHeight, userSelect: getComputedStyle(el).userSelect,
      paddingTop: parseFloat(getComputedStyle(document.querySelector("#editor .ProseMirror")).paddingTop),
      alertHeight: el.getBoundingClientRect().height,
    }));
    assert.ok(sizes.visible >= sizes.scroll - 1, JSON.stringify(sizes));
    assert.equal(sizes.userSelect, "text");
    assert.ok(sizes.paddingTop >= sizes.alertHeight, JSON.stringify(sizes));
  });
});

// ---------- 第四轮复查与复制文本 ----------
describe("fourth review and copy text", () => {
  ui("format bar cancels code blocks without losing text", { seed: seed({ "": { 页: "```python 标题\nprint(1)\n```" } }) }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="codeblock"]');
    await until(h.editor, "print(1)", "code button converts to paragraph");
    await p.keyboard.press("Control+z");
    await until(h.editor, "```python 标题\nprint(1)\n```", "undo restores language and title");
    await p.click('#format-bar [data-cmd="block"]');
    await p.click('#ctx [data-act="h0"]');
    await until(h.editor, "print(1)", "body dropdown converts code to text");
  });

  ui("Ctrl+Alt+0 preserves code lines", { seed: seed({ "": { 页: "```python\nprint(1)\nprint(2)\n```" } }) }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    await p.keyboard.press("Control+Alt+0");
    assert.ok((await h.editor()).includes("print(1)"));
    assert.ok((await h.editor()).includes("print(2)"));
    assert.ok(!(await h.editor()).includes("print(1) print(2)"));
  });

  ui("Backspace cancels code fence input rule cleanly", { seed: seed({ "": { 页: "" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.type("```");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Backspace");
    await until(() => p.locator("#editor .ProseMirror > p").textContent(), "```",
      "undo restores the three literal backticks");
    const escaped = "\\`\\`\\`";
    await until(h.editor, escaped, "Markdown escapes the backticks without adding a newline");
    await until(() => h.mockFile("", "页"), escaped, "saved text has no invisible newline");
  });

  ui("deleting final paragraph after a closed fold persists", {
    seed: seed({ "": { 页: "前文\n\n> [!fold]- 标题\n>\n> 内容\n\n后文" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").last().click({ button: "right" });
    await p.click('#ctx [data-act="block-delete"]');
    await until(async () => (await h.editor()).includes("后文"), false, "paragraph removed from editor");
    await until(async () => (await h.mockFile("", "页")).includes("后文"), false, "paragraph removal saved");
  });

  ui("a multiline paragraph becomes one copy block and retains both lines after reload", {
    seed: seed({ "": { 页: "第一行\n第二行" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    const copy = p.locator("#editor .codeblock.copyline");
    await until(() => copy.locator("code").textContent(), "第一行\n第二行", "both lines stay inside one block");
    await copy.locator(".copy").click();
    await until(() => p.evaluate(() => navigator.clipboard.readText()), "第一行\n第二行", "copies the complete multiline text");
    await until(async () => (await h.mockFile("", "页")).includes("```copy\n第一行\n第二行\n```"), true, "saved as multiline copy");
    await p.reload();
    await p.locator("#editor .codeblock.copyline code").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.equal(await p.locator("#editor .ProseMirror > p").textContent(), "第一行第二行",
      "restored paragraph retains both visual lines");
    const value = await h.editor();
    assert.ok(value.includes("第一行") && value.includes("第二行"), value);
    assert.ok(!value.includes("第一行第二行"), "line separation survives round-trip");
  });

  ui("plain code can become multiline copy and revert to code after reopening", {
    seed: seed({ "": { 页: "```\n第一行\n第二行\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    await until(async () => (await h.editor()).startsWith("```copy minipad-original-code"), true,
      "origin marker is saved");
    await p.reload();
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    await until(h.editor, "```\n第一行\n第二行\n```", "the original code block is restored");
    assert.equal(await p.locator("#editor .codeblock:not(.copyline)").count(), 1);
  });

  ui("language-tagged code rejects copy with a specific message", {
    seed: seed({ "": { 页: "```js\nconst a = 1\n```" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.match(await h.toast(), /带语言的代码块不能转成复制文本/);
    assert.equal(await h.editor(), before);
  });

  ui("selection across paragraphs is rejected with an explanation", {
    seed: seed({ "": { 页: "第一段\n\n第二段" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    await p.locator("#editor .ProseMirror > p").first().click();
    await p.keyboard.press("Control+a");
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.match(await h.toast(), /请在同一个段落中选择文字/);
    assert.equal(await h.editor(), before);
  });

  ui("empty paragraph cannot become a copy block and empty copy does not clear clipboard", {
    seed: seed({ "": { 空白: "", 空复制: "```copy\n```", 空代码: "```\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.equal(await p.locator("#editor .codeblock").count(), 0);
    assert.match(await h.toast(), /空段落不能转成复制文本/);
    await h.tab("空代码").click();
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.match(await h.toast(), /空代码块不能转成复制文本/);
    assert.equal(await p.locator("#editor .codeblock.copyline").count(), 0);
    await h.tab("空复制").click();
    await p.evaluate(() => navigator.clipboard.writeText("保留剪贴板"));
    assert.ok(await p.locator("#editor .codeblock.copyline .copy").isDisabled());
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), "保留剪贴板");
  });

  ui("copy blocks keep their own toolbar state and allow Enter to create new lines", {
    seed: seed({ "": { 页: "```copy\n第一行\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    assert.ok(await p.locator('#format-bar [data-cmd="copytext"]').evaluate((el) => el.classList.contains("on")));
    assert.ok(!(await p.locator('#format-bar [data-cmd="codeblock"]').evaluate((el) => el.classList.contains("on"))));
    assert.equal((await p.textContent('#format-bar [data-cmd="block"]')).trim(), "复制文本");
    assert.equal(await p.locator('#format-bar [data-cmd="copytext"] svg').count(), 1);
    await p.keyboard.press("End");
    await p.keyboard.press("Enter");
    await p.keyboard.type("第二行");
    await until(async () => (await h.editor()).includes("第一行\n第二行"), true,
      "Enter adds another line instead of exiting copy");
  });

  ui("quotation button unwraps normal quotes but does not nest inside folds", {
    seed: seed({ "": { 引用: "> 普通引用", 折叠: "> [!fold]+ 标题\n>\n> 内容" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor blockquote p").click();
    await p.click('#format-bar [data-cmd="quote"]');
    await until(h.editor, "普通引用", "another quote click exits the quote");
    await h.tab("折叠").click();
    await p.locator("#editor .fold-block p").last().click();
    assert.ok(!(await p.locator('#format-bar [data-cmd="quote"]').evaluate((el) => el.classList.contains("on"))));
    const before = await h.editor();
    await p.click('#format-bar [data-cmd="quote"]');
    assert.equal(await h.editor(), before, "clicking quote in a fold does not add nested quotes");
    assert.match(await h.toast(), /折叠块里不能再加引用/);
  });

  ui("Backspace removes an empty first code block", {
    seed: seed({ "": { 页: "```\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    await p.keyboard.press("Backspace");
    await until(() => p.locator("#editor .codeblock").count(), 0, "empty first code is removed");
    assert.equal(await p.locator("#editor .ProseMirror > p").count(), 1);
  });

  ui("copy text with trailing blank lines refuses unsafe conversions and preserves saved data", {
    seed: seed({ "": { 页: "```copy\n第一行\n第二行\n\n\n```" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    const originalText = await p.locator("#editor .codeblock code").textContent();
    assert.equal(originalText, "第一行\n第二行\n\n");
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.match(await h.toast(), /末尾有换行/);
    assert.equal(await h.editor(), before, "copy button refuses to discard trailing lines");
    await p.click('#format-bar [data-cmd="block"]');
    await p.click('#ctx [data-act="h0"]');
    assert.equal(await h.editor(), before, "body dropdown does not bypass safety");
    await p.keyboard.press("Control+Alt+0");
    assert.equal(await h.editor(), before, "keyboard shortcut does not bypass safety");
    await p.locator("#editor .codeblock code").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    assert.ok(await p.isDisabled('#ctx [data-act="block-type-paragraph"]'),
      "block menu cannot discard trailing lines either");
    await h.sync();
    await until(() => h.mockFile("", "页"), before, "the complete source is saved");
    await p.reload();
    assert.equal(await p.locator("#editor .codeblock code").textContent(), originalText,
      "every trailing blank line survives reopening");
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="codeblock"]');
    await until(h.editor, "```\n第一行\n第二行\n\n\n```", "the code button turns copy text into normal code with every line");
  });

  ui("block menu preserves soft breaks when converting plain paragraph to code", {
    seed: seed({ "": { 页: "第一行\n第二行" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    assert.equal(await p.isDisabled('#ctx [data-act="block-type-code_block"]'), false);
    await p.click('#ctx [data-act="block-type-code_block"]');
    assert.equal(await p.locator("#editor .codeblock code").textContent(), "第一行\n第二行",
      "Shift+Enter line break is kept inside the code block");
    await until(h.editor, "```\n第一行\n第二行\n```");
  });

  ui("block menu rejects converting rich text or links into plain code", {
    seed: seed({ "": { 页: "前文 **粗体** [链接](https://example.com) 尾" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    await p.locator("#editor .ProseMirror > p").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    assert.ok(await p.isDisabled('#ctx [data-act="block-type-code_block"]'));
    assert.equal(await h.editor(), before, "links and formatting stay intact");
    await h.sync();
    assert.equal(await h.mockFile("", "页"), before);
  });

  ui("block menu converting existing code to code keeps language and title", {
    seed: seed({ "": { 页: "```python 打招呼\nprint(1)\n```" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    await p.locator("#editor .codeblock code").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    await p.click('#ctx [data-act="block-type-code_block"]');
    assert.equal(await h.editor(), before, "converting a code block to itself is lossless");
    assert.equal(await p.locator("#editor .cb-lang").inputValue(), "python");
    assert.equal(await p.locator("#editor .cb-title").inputValue(), "打招呼");
    await h.sync();
    assert.equal(await h.mockFile("", "页"), before);
  });

  ui("nonempty blocks cannot be converted to a horizontal rule but empty paragraphs can", {
    seed: seed({ "": { 有内容: "重要原文", 空白: "" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    assert.ok(await p.isDisabled('#ctx [data-act="block-type-hr"]'));
    assert.equal(await h.editor(), "重要原文");
    await h.tab("空白").click();
    await p.locator("#editor .ProseMirror > p").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    assert.equal(await p.isDisabled('#ctx [data-act="block-type-hr"]'), false);
    await p.click('#ctx [data-act="block-type-hr"]');
    assert.equal(await p.locator("#editor .ProseMirror > hr").count(), 1);
  });

  ui("a literal [!fold] prefix in an ordinary quote can still be unwrapped", {
    seed: seed({ "": { 页: "> [!fold]普通引用" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor blockquote p").click();
    await p.click('#format-bar [data-cmd="quote"]');
    await until(() => p.locator("#editor .ProseMirror > p").textContent(), "[!fold]普通引用",
      "only valid folding markers suppress quote unwrapping");
    assert.equal(await p.locator("#editor blockquote").count(), 0);
  });

  ui("copy text has a compact toolbar action, clipboard and Markdown persistence", {
    seed: seed({ "": { 页: "npm install" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    await until(h.editor, "```copy\nnpm install\n```", "copy block persists in Markdown");
    assert.equal(await p.locator("#editor .codeblock.copyline").count(), 1);
    await p.locator("#editor .codeblock.copyline .copy").click();
    await until(() => p.evaluate(() => navigator.clipboard.readText()), "npm install", "one-click copy");
    await until(() => h.mockFile("", "页"), "```copy\nnpm install\n```", "saved to file");
    await p.click('#format-bar [data-cmd="copytext"]');
    await until(h.editor, "npm install", "copy block can be turned into text");
  });

  ui("copy text refuses a table cell without splitting the table or saving", {
    seed: seed({ "": { 页: "| A | B |\n| --- | --- |\n| 单元格 | 另一格 |\n| 下行 | 数据 |" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    const file = await h.mockFile("", "页");
    await p.locator("#editor table td").first().click();
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.match(await h.toast(), /复制文本只能放没有格式的文字/);
    assert.equal(await h.editor(), before, "table Markdown stays unchanged");
    assert.equal(await p.locator("#editor table").count(), 1, "one intact table");
    assert.equal(await p.locator("#editor table tr").count(), 3, "all rows remain");
    await h.sync();
    assert.equal(await h.mockFile("", "页"), file, "the file is unchanged");
  });

  ui("copy text refuses the first paragraph in a list and a task", {
    seed: seed({ "": { 列表: "- 列表项", 任务: "- [ ] 任务项" } }),
  }, async (h) => {
    const { p } = h;
    for (const [name, expected] of [["列表", "- 列表项"], ["任务", "- [ ] 任务项"]]) {
      if (name === "任务") await h.tab(name).click();
      await p.locator("#editor ul li p").first().click();
      await p.click('#format-bar [data-cmd="copytext"]');
      assert.match(await h.toast(), /复制文本只能放没有格式的文字/);
      assert.equal(await h.editor(), expected, "list or task stays intact");
      assert.equal(await p.locator("#editor ul li p").count(), 1, "no extra paragraph inserted");
      await h.sync();
      assert.equal(await h.mockFile("", name), expected, "no change to the file");
    }
  });

  ui("copy text rejects a formatted paragraph in the bar and block menu", {
    seed: seed({ "": { 页: '前文 **粗体** [链接](https://example.com) <span style="color: #df2a3f">红字</span> 尾' } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    const file = await h.mockFile("", "页");
    const para = p.locator("#editor .ProseMirror > p");
    await para.click();
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.match(await h.toast(), /复制文本只能放没有格式的文字/);
    assert.equal(await h.editor(), before, "marks and links are retained");
    await para.click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    assert.ok(await p.isDisabled('#ctx [data-act="block-type-copytext"]'), "block menu rejects the same source");
    assert.equal(await h.editor(), before);
    await h.sync();
    assert.equal(await h.mockFile("", "页"), file);
  });

  ui("selected text can become a copy line from the floating toolbar", {
    seed: { ...seed({ "": { 页: "选中的纯文字" } }), settings: { ...SETTINGS, sel_bar_items: ["copytext"] } },
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click();
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+ArrowLeft");
    await p.keyboard.press("Shift+ArrowLeft");
    await p.locator('#toolbar [data-cmd="copytext"]').click();
    await until(() => p.locator("#editor .codeblock.copyline").count(), 1,
      "floating toolbar converts the full paragraph");
    assert.equal(await p.locator("#editor .codeblock code").textContent(), "选中的纯文字");
    await until(async () => (await h.mockFile("", "页")).includes("copy"),
      true, "the converted paragraph is saved");
  });

  ui("block menu refuses titled or multiline code and headings without data loss", {
    seed: seed({ "": { 代码: "~~~python 标题\nprint(1)\nprint(2)\n~~~", 标题: "## 二级标题" } }),
  }, async (h) => {
    const { p } = h;
    const before = await h.editor();
    await p.locator("#editor .codeblock code").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    assert.ok(await p.isDisabled('#ctx [data-act="block-type-copytext"]'));
    assert.equal(await h.editor(), before);
    await h.tab("标题").click();
    const heading = await h.editor();
    await p.locator("#editor h2").click();
    await p.click('#format-bar [data-cmd="copytext"]');
    assert.match(await h.toast(), /复制文本只能放没有格式的文字/);
    assert.equal(await h.editor(), heading, "heading level is preserved");
  });

  ui("the quote button moves a whole list out of a quote instead of unwrapping one item", {
    seed: seed({ "": { 页: "> - 列表项\n> - 第二项\n\n> 第一段\n>\n> 第二段" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor blockquote li p").first().click();
    await p.click('#format-bar [data-cmd="quote"]');
    await until(h.editor, "- 列表项\n- 第二项\n\n> 第一段\n>\n> 第二段", "the list leaves the quote with both items");
    await p.locator("#editor blockquote p").first().click();
    await p.click('#format-bar [data-cmd="quote"]');
    await until(h.editor, "- 列表项\n- 第二项\n\n第一段\n\n> 第二段", "a paragraph still leaves a longer quote on its own");
  });

  ui("in a copy block the code button and the block menu make normal code", {
    seed: seed({ "": { 按钮: "```copy\nnpm i\n```", 菜单: "```copy minipad-original-code\nnpm i\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    await p.click('#format-bar [data-cmd="codeblock"]');
    await until(h.editor, "```\nnpm i\n```", "the code button gives normal code");
    assert.ok(await p.locator('#format-bar [data-cmd="codeblock"]').evaluate((el) => el.classList.contains("on")));
    await h.tab("菜单").click();
    await p.locator("#editor .codeblock code").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    await p.click('#ctx [data-act="block-type-code_block"]');
    await until(h.editor, "```\nnpm i\n```", "the block menu gives normal code");
    assert.equal(await p.locator("#editor .codeblock.copyline").count(), 0);
  });

  ui("block menu keeps the trailing lines of a copy block inside a quote or a fold", {
    seed: seed({ "": { 引用: "> ```copy\n> npm i\n>\n> ```", 折叠: "> [!fold]+ 标题\n>\n> ```copy\n> npm i\n>\n> ```" } }),
  }, async (h) => {
    const { p } = h;
    for (const name of ["引用", "折叠"]) {
      if (name === "折叠") await h.tab(name).click();
      const before = await h.editor();
      await p.locator("#editor .ProseMirror > blockquote").click({ button: "right", position: { x: 4, y: 4 } });
      await p.click('#ctx [data-act="block-convert"]');
      assert.ok(await p.isDisabled('#ctx [data-act="block-type-paragraph"]'), `${name}: no plain text that drops the blank line`);
      await p.keyboard.press("Escape");
      assert.equal(await h.editor(), before);
    }
  });

  ui("the third Enter at the end of a copy block leaves it like a code block", {
    seed: seed({ "": { 页: "```copy\nnpm i\n```\n\n尾" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click();
    await p.keyboard.press("End");
    for (let i = 0; i < 3; i++) await p.keyboard.press("Enter");
    await p.keyboard.type("x");
    await until(h.editor, "```copy\nnpm i\n```\n\nx\n\n尾", "no blank lines are left in the copy block");
  });

  ui("a line break at the end of a paragraph is dropped when it becomes copy text", {
    seed: seed({ "": { 页: "abc" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click();
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+Enter");
    await p.click('#format-bar [data-cmd="copytext"]');
    await until(h.editor, "```copy\nabc\n```", "the format bar drops the trailing break");
    await p.click('#format-bar [data-cmd="copytext"]');
    await until(h.editor, "abc", "and the copy text turns back into the paragraph");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+Enter");
    await p.locator("#editor .ProseMirror > p").click({ button: "right" });
    await p.click('#ctx [data-act="block-convert"]');
    await p.click('#ctx [data-act="block-type-copytext"]');
    await until(h.editor, "```copy\nabc\n```", "the block menu drops it too");
  });
});

describe("block handle within reach", () => {
  // 像手移鼠标一样一像素一像素地移过去，途中每一步都会触发 mousemove
  const glide = async (p, from, to) => {
    await p.mouse.move(from.x, from.y);
    await p.mouse.move(to.x, to.y, { steps: Math.max(1, Math.round(Math.hypot(to.x - from.x, to.y - from.y))) });
  };
  const middle = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

  ui("the handle stays put while the mouse moves from the text over to it", {
    seed: seed({ "": { 页: "第一段\n\n- 甲\n  - 乙一\n\n> 引用一\n>\n> 引用二\n\n尾段" } }),
  }, async (h) => {
    const { p } = h;
    const handle = p.locator(".block-handle");
    for (const [selector, after] of [
      ["#editor .ProseMirror > p >> nth=0", "- 甲\n  - 乙一\n\n> 引用一\n>\n> 引用二\n\n尾段"],
      ["#editor li li", "- 甲\n\n> 引用一\n>\n> 引用二\n\n尾段"],
      ["#editor blockquote p >> nth=0", "- 甲\n\n> 引用二\n\n尾段"],
    ]) {
      const text = await p.locator(selector).boundingBox();
      const start = { x: text.x + 30, y: text.y + 8 };
      await p.mouse.move(start.x, start.y);
      const at = await handle.boundingBox();
      await glide(p, start, middle(at));
      assert.ok(await handle.isVisible(), `${selector}: the handle is still there`);
      assert.deepEqual(await handle.boundingBox(), at, `${selector}: and has not jumped to an outer block`);
      await handle.click();
      await p.click('#ctx button[data-act="block-delete"]');
      await until(h.editor, after, `${selector}: its menu deletes just that block`);
    }
  });

  ui("the handle follows the rows down the left margin, and a drop in a gap lands there", {
    seed: seed({ "": { 页: "甲\n\n乙\n\n丙\n\n丁" } }),
  }, async (h) => {
    const { p } = h;
    const handle = p.locator(".block-handle");
    const blocks = p.locator("#editor .ProseMirror > p");
    await blocks.first().hover();
    const column = middle(await handle.boundingBox());
    const third = await blocks.nth(2).boundingBox();
    let gone = 0;
    for (let y = column.y; y <= third.y + 8; y++) {
      await p.mouse.move(column.x, y);
      if (await handle.isHidden()) gone++;
    }
    assert.equal(gone, 0, "the handle never disappears between blocks");
    assert.ok(Math.abs((await handle.boundingBox()).y - third.y) < 4, "it now sits beside the third block");
    await handle.click();
    await p.click('#ctx button[data-act="block-delete"]');
    await until(h.editor, "甲\n\n乙\n\n丁", "its menu deletes the third block");

    const editor = p.locator("#editor .ProseMirror");
    const pm = await editor.boundingBox();
    const [b1, b2] = [await blocks.nth(1).boundingBox(), await blocks.nth(2).boundingBox()];
    await blocks.first().hover();
    await handle.dragTo(editor, { targetPosition: { x: 100, y: (b1.y + b1.height + b2.y) / 2 - pm.y } });
    await until(h.editor, "乙\n\n甲\n\n丁", "dropped in the gap between two blocks, not at the end");
    await blocks.last().hover();
    const top = await blocks.first().boundingBox();
    await handle.dragTo(editor, { targetPosition: { x: 10, y: top.y + 3 - pm.y } });
    await until(h.editor, "丁\n\n乙\n\n甲", "dropped in the left margin beside a block, not at the end");
  });

  for (const shown of [true, false]) {
    const db = seed({ "": { 页: "# 标题\n\n第一段文字" } });
    Object.assign(db.settings, { outline_enabled: shown, outline_side: "left" });
    ui(`with the outline on the left (${shown ? "shown" : "off"}) the handle leaves the text start clickable`, {
      seed: db,
    }, async (h) => {
      const { p } = h;
      const para = p.locator("#editor .ProseMirror > p");
      await para.hover();
      const text = await para.boundingBox();
      const at = await p.locator(".block-handle").boundingBox();
      assert.ok(at.x + at.width <= text.x, "the handle ends before the text starts");
      if (shown) {
        const marks = await p.locator("#outline").boundingBox();
        assert.ok(marks.x + marks.width <= at.x + 1, "and does not cover the outline marks");
      }
      assert.ok(await p.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("#editor p"),
        [text.x + 2, text.y + text.height / 2]), "the first letter can be clicked");
    });
  }
});

// ---------- 代码块 ----------
describe("disk sync and saving", () => {
  ui("a disk read started before a completed save cannot restore stale content", {
    seed: seed({ "": { 页: "原内容" } }),
  }, async (h) => {
    const { p } = h;
    await p.evaluate(async () => {
      const { api } = await import("./js/api.js");
      const invoke = api.invoke;
      let delayed = false;
      api.invoke = async (...args) => {
        const result = await invoke(...args);
        if (args[0] === "read_notes" && !delayed) {
          delayed = true;
          await new Promise((resolve) => { window.__releaseDiskRead = resolve; });
        }
        return result;
      };
    });
    // 切回窗口时的那次读取还没回来
    await p.evaluate(() => void window.__minipad.sync());
    await until(() => p.evaluate(() => typeof window.__releaseDiskRead), "function");
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("Control+End");
    await p.keyboard.type(" local");
    await until(() => h.mockFile("", "页"), "原内容 local");
    await p.evaluate(() => window.__releaseDiskRead());
    await sleep(100);
    assert.equal(await h.editor(), "原内容 local", "stale read never replaces the just-saved edit");
  });
});

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
  ui("collapsed code blocks survive saving, changing pages and restarting", {
    seed: seed({ "": { ...CODE_PAGE[""], 其他: "另一页" } }),
  }, async (h) => {
    const { p } = h;
    const blocks = p.locator("#editor .codeblock");
    for (let i = 0; i < 2; i++) await blocks.nth(i).locator(".cb-toggle").click();
    await p.evaluate(() => window.__minipad.flush());
    await h.tab("其他").click();
    await h.tab("代码").click();
    assert.equal(await blocks.locator("pre:visible").count(), 0, "changing pages keeps both blocks collapsed");
    await p.reload();
    await blocks.first().waitFor();
    assert.equal(await blocks.locator("pre:visible").count(), 0, "restart keeps both blocks collapsed");
    assert.deepEqual(await blocks.locator(".cb-title").evaluateAll((els) => els.map((el) => el.value)), ["牛奶测试", ""]);
    assert.deepEqual(await blocks.locator(".cb-lang").evaluateAll((els) => els.map((el) => el.value)), ["js", ""]);
    for (let i = 0; i < 2; i++) await blocks.nth(i).locator(".cb-toggle").click();
    await p.evaluate(() => window.__minipad.flush());
    assert.equal(await h.mockFile("", "代码"), CODE_PAGE[""].代码, "expanding restores the original Markdown");
    await p.reload();
    await blocks.first().waitFor();
    assert.equal(await blocks.locator("pre:visible").count(), 2, "expanded state survives restart too");
  });

  ui("a collapsed copy-text block turns into an expanded code block", {
    seed: seed({ "": { 页: "```copy [minipad-folded]\n复制这段\n```" } }),
  }, async (h) => {
    const { p } = h;
    const block = p.locator("#editor .codeblock");
    assert.ok(await block.locator("pre").isHidden(), "starts collapsed");
    await block.click({ button: "right" });
    await p.click('#ctx button[data-act="block-convert"]');
    await p.click('#ctx button[data-act="block-type-code_block"]');
    await until(() => block.locator("pre").isVisible(), true, "the converted code block is expanded");
    await p.evaluate(() => window.__minipad.flush());
    assert.equal(await h.mockFile("", "页"), "```\n复制这段\n```");
  });

  for (const readOnly of [false, true]) {
    ui(`code folding is temporary when ${readOnly ? "the page is read-only" : "persistence is disabled"}`, {
      seed: { ...seed(CODE_PAGE), settings: { ...SETTINGS, fold_save_state: readOnly } },
    }, async (h) => {
      const { p } = h;
      if (readOnly) {
        await p.evaluate(() => {
          window.__mockControl = { unreadable: { "": { 代码: "测试读取失败" } } };
        });
        await h.sync();
      }
      const first = p.locator("#editor .codeblock").first();
      await first.locator(".cb-toggle").click();
      assert.ok(await first.locator("pre").isHidden());
      await p.evaluate(() => window.__minipad.flush());
      assert.equal(await h.mockFile("", "代码"), CODE_PAGE[""].代码);
      assert.equal(await h.editor(), CODE_PAGE[""].代码, "temporary state never enters Markdown");
      await p.reload();
      await first.waitFor();
      assert.ok(await first.locator("pre").isVisible());
    });
  }

  ui("external code fold changes preserve titles and code content", {
    seed: seed({ "": { 页: "```中文标题\n原代码\n```" } }),
  }, async (h) => {
    const { p } = h;
    const block = p.locator("#editor .codeblock");
    await block.locator(".cb-toggle").click();
    await p.evaluate(() => window.__minipad.flush());
    assert.equal(await h.mockFile("", "页"), "```中文标题 [minipad-folded]\n原代码\n```");
    await p.reload();
    await block.waitFor();
    assert.equal(await block.locator(".cb-title").inputValue(), "中文标题");
    assert.equal(await block.locator(".cb-lang").inputValue(), "");
    assert.ok(await block.locator("pre").isHidden());
    await p.evaluate(() => { window.__mockFiles.页 = "```python 新标题\n新代码\n```"; });
    await h.sync();
    assert.ok(await block.locator("pre").isVisible(), "external expanded state is applied");
    assert.equal(await block.locator(".cb-title").inputValue(), "新标题");
    assert.equal(await block.locator("code").textContent(), "新代码");
  });

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

  ui("Enter at a blank final code line opens a normal paragraph with heading formatting", {
    seed: seed({ "": { 页: "```js\nconst a = 1\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.click("#editor .codeblock code");
    await p.keyboard.press("Control+End");
    await p.keyboard.press("Enter");
    await p.keyboard.type("const b = 2");
    assert.equal(await h.editor(), "```js\nconst a = 1\nconst b = 2\n```",
      "an ordinary Enter still adds a line inside the code");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    await p.keyboard.type("正文");
    assert.equal(await h.editor(), "```js\nconst a = 1\nconst b = 2\n```\n\n正文");
    assert.equal(await p.locator("#editor .ProseMirror > p").count(), 1,
      "the cursor exits the code block into a paragraph");
    await p.click('#format-bar [data-cmd="block"]');
    await p.click('#ctx button[data-act="h2"]');
    assert.equal(await h.editor(), "```js\nconst a = 1\nconst b = 2\n```\n\n## 正文",
      "the following paragraph can become a heading");
    await until(() => h.mockFile("", "页"), "```js\nconst a = 1\nconst b = 2\n```\n\n## 正文",
      "new heading is saved as Markdown");
  });

  ui("Ctrl+Enter exits a code block with following content; task shortcut still works", {
    seed: seed({ "": { 页: "```python\nprint(1)\n```\n\n后段" } }),
  }, async (h) => {
    const { p } = h;
    await p.click("#editor .codeblock code");
    await p.keyboard.press("Control+Home");
    await p.keyboard.press("Control+Enter");
    await p.keyboard.type("新正文");
    assert.equal(await h.editor(), "```python\nprint(1)\n```\n\n新正文\n\n后段",
      "Ctrl+Enter adds a paragraph after the code block without changing its content");
    await p.keyboard.press("Control+Enter");
    assert.match(await h.editor(), /- \[ \] 新正文/, "Ctrl+Enter still creates a task outside code blocks");
  });

  ui("block menu and code keyboard exit work together", {
    seed: seed({ "": { 页: "```js\nconst a = 1\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock code").click({ button: "right" });
    await p.click('#ctx button[data-act="block-insert-after"]');
    await p.click('#ctx button[data-act="block-type-paragraph"]');
    await p.keyboard.type("菜单段落");
    assert.equal(await h.editor(), "```js\nconst a = 1\n```\n\n菜单段落",
      "the block menu adds a paragraph");

    await p.locator("#editor .codeblock code").click();
    await p.keyboard.press("Control+Enter");
    await p.keyboard.type("快捷段落");
    assert.equal(await h.editor(), "```js\nconst a = 1\n```\n\n快捷段落\n\n菜单段落",
      "keyboard exit inserts another paragraph without replacing the menu-created one");
  });

  ui("code line numbers can be turned off in the settings", { seed: seed(CODE_PAGE) }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock").first().waitFor();
    const numbered = () => p.$eval("#editor .cb-gutter", (e) => getComputedStyle(e).display !== "none");
    assert.equal(await numbered(), true, "on by default");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    await p.locator("#settings").waitFor();
    assert.equal(await p.isChecked("#set-code-lines"), true);
    await p.uncheck("#set-code-lines");
    await p.click("#set-save");
    await until(numbered, false, "line numbers hidden");
    await until(async () => (await h.stored())?.settings?.code_line_numbers, false, "the setting is saved");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
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
  // 0.2.9 的按钮;0.3.0 在最后加了竖线和查找
  const OLD_BAR = "undo redo sep1 block sep2 strong em strike code link color bg sep3 list ol task sep4 quote codeblock table hr".split(" ");
  const DEFAULT_BAR = [...OLD_BAR.slice(0, OLD_BAR.indexOf("codeblock")), "copytext",
    ...OLD_BAR.slice(OLD_BAR.indexOf("codeblock")), "sep5", "find"];

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

  ui("text and background colors are saved as spans in the Markdown", { seed: seed({ "": { 页: '红<span style="color: #e5484d">字</span>' } }) }, async (h) => {
    const { p } = h;
    assert.equal(await p.locator('#editor span[data-color="#e5484d"]').textContent(), "字", "a colored span in the file shows in color");
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+ArrowLeft");
    await until(h.selection, "字");
    assert.ok(await p.locator(`${fb("color")}.on`).isVisible(), "the color button shows the selection has a color");
    await p.click(fb("color"));
    await p.locator(".fb-pop").waitFor();
    await expandLibrary(p, ".fb-pop .shared-colors");
    assert.ok(await p.locator('.fb-pop .uc-swatch[data-color="#e5484d"]').isVisible(), "the current color is available");
    await expandLibrary(p, ".fb-pop");
    await p.click('.fb-pop .uc-swatch[data-color="#3b82f6"]');
    assert.equal(await h.editor(), '红<span style="color: #3b82f6">字</span>', "a new text color");
    await p.keyboard.press("Shift+Home");
    await until(h.selection, "红字", "the expanded selection is ready before applying the background");
    await p.click(fb("bg"));
    await expandLibrary(p, ".fb-pop");
    await p.click('.fb-pop .uc-swatch[data-color="#fbe9a6"]');
    assert.equal(
      await h.editor(),
      '<span style="background-color: #fbe9a6">红<span style="color: #3b82f6">字</span></span>',
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

  ui("the buttons on the bar are reordered by dragging them in the panel, and the order is kept", { seed: seed({ "": { 页: "文字" } }) }, async (h) => {
    const { p } = h;
    const bar = () => p.$$eval("#format-bar .fb-items > [data-cmd]:not([hidden])", (els) => els.map((e) => e.dataset.cmd));
    const panel = () => p.$$eval(".fb-pop .fb-check", (els) => els.map((e) => e.dataset.id));
    const start = await bar();
    assert.deepEqual(start.slice(0, 4), ["undo", "redo", "sep1", "block"]);
    await p.click("#format-bar .fb-more");
    assert.deepEqual((await panel()).filter((id) => !id.startsWith("sep")), start.filter((id) => !id.startsWith("sep")), "the panel lists the buttons in bar order");
    // 任务拖到最前面
    await p.locator('.fb-check[data-id="task"]').dragTo(p.locator('.fb-check[data-id="undo"]'), { targetPosition: { x: 20, y: 2 } });
    await until(async () => (await bar())[0], "task", "the bar follows at once");
    assert.equal((await panel())[0], "task", "and so does the panel");
    // 粗体拖到斜体后面
    await p.locator('.fb-check[data-id="strong"]').dragTo(p.locator('.fb-check[data-id="em"]'), { targetPosition: { x: 20, y: 17 } });
    const after = await bar();
    assert.equal(after.indexOf("strong"), after.indexOf("em") + 1, "dropped on the lower half goes after");
    await until(async () => (await h.stored())?.settings?.format_bar_order?.slice(0, 3), ["task", "undo", "redo"], "saved");
    // 关掉一条竖线分隔
    await p.uncheck('.fb-pop input[value="sep2"]');
    assert.ok(await p.isHidden('#format-bar [data-cmd="sep2"]'), "a separator can be turned off too");
    await p.keyboard.press("Escape");
    await p.reload();
    await p.waitForSelector(fb("strong"));
    assert.deepEqual(await bar(), after.filter((id) => id !== "sep2"), "the order survives a restart");
    // 恢复默认
    await p.click("#format-bar .fb-more");
    await p.click(".fb-pop .fb-reset");
    assert.deepEqual(await bar(), start, "back to the default order");
    await until(async () => (await h.stored())?.settings?.format_bar_hidden, [], "nothing hidden");
  });

  ui("a button the saved order does not know yet (added in a newer version) goes back to its default place", { seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, format_bar_order: [...OLD_BAR].reverse().filter((id) => id !== "table").concat(["nope", "strong"]) } } }, async (h) => {
    const { p } = h;
    const bar = await p.$$eval("#format-bar .fb-items > [data-cmd]", (els) => els.map((e) => e.dataset.cmd));
    assert.equal(bar[0], "hr", "the saved order is used");
    assert.equal(bar.indexOf("copytext"), bar.indexOf("quote") + 1, "the copy-text button is restored next to quote");
    assert.equal(bar.indexOf("table"), bar.indexOf("codeblock") + 1, "table stays after codeblock");
    assert.deepEqual(bar.slice(1, 3), ["sep5", "find"], "so do the find button and its divider from 0.3.0");
    assert.equal(bar.filter((id) => id === "strong").length, 1, "no duplicates");
    assert.ok(!bar.includes("nope"), "unknown names are dropped");
    assert.equal(bar.length, DEFAULT_BAR.length);
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
describe("shared colors and positioned gradients", () => {
  ui("save once in accent and reuse from edge, notebook and text palettes", { seed: seed({ "": { 页: "笔记" }, 工作: { 文件: "内容" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const accent = p.locator("#set-accent").locator("..").locator(".shared-colors");
    await expandLibrary(p, "#set-accent + .shared-colors");
    await accent.locator(":scope > .uc-actions button").nth(1).click();
    assert.ok(await accent.locator('.uc-swatch[data-color="#d9822b"]').isVisible());
    await settingsPage(p, "window");
    assert.ok(await p.locator('#set-edge-color + .shared-colors .uc-swatch[data-color="#d9822b"]').isVisible());
    await p.locator('#set-edge-color + .shared-colors .uc-swatch[data-color="#d9822b"]').click();
    await p.click("#set-save");
    await until(() => h.stored().then((db) => db.settings.edge_color), "#d9822b");
    await h.openBooks();
    await p.click("#books-manage");
    await p.click('#bm-list [data-book="工作"]');
    const saved = p.locator('#book-manager .shared-colors .uc-swatch[data-color="#d9822b"]');
    assert.equal(await saved.count(), 1);
    await saved.click();
    await until(() => h.stored().then((db) => db.books["工作"].meta.icon_color), "#d9822b");
  });

  ui("multistop custom gradient stores angles, positions and can delete stops", { seed: seed({ "": { 页: "内容" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, "#set-accent + .shared-colors");
    const tool = p.locator("#set-accent").locator("..").locator(".shared-colors");
    await tool.locator(".uc-actions button").first().click();
    await tool.locator("select").selectOption("gradient");
    await tool.locator(".uc-editor .uc-actions button").first().click();
    assert.equal(await tool.locator(".uc-stop").count(), 3);
    await tool.locator('input[aria-label="渐变角度"]').fill("90");
    await tool.locator('input[aria-label="渐变角度"]').dispatchEvent("change");
    await tool.locator('input[aria-label="节点 2 位置"]').fill("38");
    await tool.locator('input[aria-label="节点 2 位置"]').dispatchEvent("change");
    await tool.locator(".uc-editor .uc-actions .primary").click();
    await p.click("#set-save");
    await until(() => h.stored().then((db) => db.settings.accent),
      "linear-gradient(90deg, #d9822b 0%, #d9822b 38%, #d66cf0 100%)");
  });
});

describe("v0.3.5 remaining color UX details", () => {
  ui("pencil-free swatches support F2 and right-click editing", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, color_library: ["#123abc", "#fbe9a6"] } },
  }, async ({ p }) => {
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const library = p.locator("#set-accent + .shared-colors");
    assert.equal(await library.locator(".uc-modify").count(), 0, "the pencil no longer overlaps tiny swatches");
    const color = library.locator('.uc-swatch[data-color="#123abc"]');
    await color.focus();
    await p.keyboard.press("F2");
    assert.equal(await library.locator(".uc-more").getAttribute("aria-expanded"), "true",
      "F2 expands a quick swatch directly");
    assert.ok(await library.locator(".uc-editor").isVisible(), "F2 opens the existing editor");
    await library.locator(":scope > .uc-actions button").first().click();
    assert.ok(await library.locator(".uc-editor").isHidden());
    await color.click({ button: "right" });
    assert.ok(await library.locator(".uc-editor").isVisible(), "right-click edits a preset");
    assert.equal(await library.locator(".uc-delete").count(), 2, "delete remains available separately");
    const toggle = library.locator(".uc-more");
    assert.equal(await toggle.textContent(), "−");
    assert.equal(await toggle.getAttribute("aria-label"), "收起颜色库");
    const fits = await toggle.evaluate((node) => node.scrollHeight <= node.clientHeight);
    assert.ok(fits, "collapse symbol fits the small toggle");
  });

  ui("notebook follow-accent is labeled and header styles match the color library", {
    seed: seed({ "": { 首页: "正文" }, 工作: { 文档: "示例" } }),
  }, async (h) => {
    const { p } = h;
    await h.openBooks();
    await p.click("#books-manage");
    assert.equal(await p.textContent("#bm-details .bm-follow-color span"), "跟随强调色");
    assert.equal(await p.locator('#bm-colors [data-color=""]').count(), 1);
    const appearance = await p.evaluate(() => ({
      defaultWeight: getComputedStyle(document.querySelector("#bm-details .bm-field-title")).fontWeight,
      libraryWeight: getComputedStyle(document.querySelector("#bm-details .uc-title")).fontWeight,
      headerDivider: getComputedStyle(document.querySelector(".bm-head")).borderBottomWidth,
      titleDivider: getComputedStyle(document.querySelector("#bm-selected")).borderTopWidth,
      titlePadding: getComputedStyle(document.querySelector("#bm-selected")).paddingTop,
      followText: document.querySelector('#bm-colors [data-color=""]').textContent,
    }));
    assert.equal(appearance.defaultWeight, appearance.libraryWeight);
    assert.equal(appearance.headerDivider, "1px", "manager header retains its divider");
    assert.equal(appearance.titleDivider, "0px", "book title has no extra divider");
    assert.equal(appearance.titlePadding, "0px");
    assert.equal(appearance.followText, "", "follow-accent swatch has no misleading reset glyph");
  });

  ui("format color editor scrolls into view inside a short window", {
    seed: seed({ "": { 页: "文字" } }),
  }, async ({ p }) => {
    await p.click('#format-bar [data-cmd="color"]');
    const palette = p.locator(".fb-pop .shared-colors");
    await palette.locator(".uc-swatch").first().click({ button: "right" });
    assert.ok(await palette.locator(".uc-editor").isVisible());
    await until(async () => p.locator(".fb-pop .uc-editor .primary").evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= window.innerHeight - 4;
    }), true, "editor apply button stays reachable after opening");
    const toggle = palette.locator(".uc-more");
    assert.equal(await toggle.textContent(), "−");
    assert.ok(await toggle.evaluate((el) => el.scrollHeight <= el.clientHeight));
  });

  ui("pale font swatches warn about contrast and keep their A preview", {
    seed: seed({ "": { 页: "文字" } }),
  }, async ({ p }) => {
    await p.click('#format-bar [data-cmd="color"]');
    await expandLibrary(p, ".fb-pop .shared-colors");
    const pale = p.locator('.fb-pop .uc-swatch[data-color="#fbe9a6"]');
    assert.equal(await pale.getAttribute("data-contrast-warning"), "light-text");
    assert.match(await pale.getAttribute("title"), /对比度/);
    assert.equal(await pale.textContent(), "A");
    const dark = p.locator('.fb-pop .uc-swatch[data-color="#e5484d"]');
    assert.equal(await dark.getAttribute("data-contrast-warning"), null);
  });
});

describe("v0.3.7 categorized color library", () => {
  ui("expanded colors have one quick section and separate remainder types", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS,
      color_library: [
        "linear-gradient(90deg, #111111, #eeeeee)",
        "#334455", "#556677", "linear-gradient(45deg, #ff0000, #0000ff)",
        "#778899", "#123456", "linear-gradient(180deg, #00ff00, #0000ff)", "#abcdef",
      ],
    } },
  }, async ({ p }) => {
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const root = "#set-accent + .shared-colors";
    const library = p.locator(root);
    const original = [
      "linear-gradient(90deg, #111111, #eeeeee)",
      "#334455", "#556677", "linear-gradient(45deg, #ff0000, #0000ff)",
      "#778899", "#123456", "linear-gradient(180deg, #00ff00, #0000ff)", "#abcdef",
    ];
    const visible = () => library.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.color));
    await showKind(p, root, "solid");
    assert.deepEqual(await visible(), ["#334455", "#556677", "#778899"], "the 纯色 tab shows only solid quick colors");
    assert.equal(await library.locator(".uc-kind-title").count(), 0, "collapsed has no section headings");
    await expandLibrary(p, root);
    assert.deepEqual(await library.locator(".uc-kind-title").allTextContents(), ["快捷（收起时显示）", "纯色"]);
    const visual = await library.locator(".uc-presets").evaluate((el) =>
      [...el.querySelectorAll(".uc-kind-title, .uc-preset")].map((node) => ({
        name: node.classList.contains("uc-kind-title") ? node.textContent : node.dataset.color,
        top: node.getBoundingClientRect().top,
      })));
    assert.deepEqual(visual.map((item) => item.name), [
      "快捷（收起时显示）", "#334455", "#556677", "#778899", "纯色", "#123456", "#abcdef",
    ], "each color appears in exactly one section");
    assert.ok(visual[3].top < visual[4].top, "the category heading starts below the quick row");
    await showKind(p, root, "gradient");
    assert.deepEqual(await library.locator(".uc-kind-title").allTextContents(), ["快捷（收起时显示）", "渐变色"]);
    assert.deepEqual(await sectionColors(library, "quick"), [original[0], original[3]]);
    assert.deepEqual(await sectionColors(library, "gradient"), [original[6]]);
    await library.locator(".uc-more").click();
    assert.deepEqual(await visible(), [original[0], original[3]], "collapsed quick colors preserve the stored order");
  });

  ui("all-gradient libraries still show a category heading and keep edit actions available", {
    seed: { ...seed({ "": { 页: "正文" } }), settings: {
      ...SETTINGS, color_library: ["linear-gradient(135deg, #5fb4ff, #d66cf0)"],
    } },
  }, async ({ p }) => {
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const library = p.locator("#set-accent + .shared-colors");
    await expandLibrary(p, "#set-accent + .shared-colors");
    await showKind(p, "#set-accent + .shared-colors", "gradient");
    assert.deepEqual(await library.locator(".uc-kind-title").allTextContents(), ["快捷（收起时显示）", "渐变色"],
      "the only quick color can still be dragged back to its type");
    assert.equal(await library.locator('.uc-preset[data-color="linear-gradient(135deg, #5fb4ff, #d66cf0)"]').count(), 1);
    const gradient = library.locator(".uc-swatch").first();
    await gradient.click({ button: "right" });
    assert.equal(await library.locator('select[aria-label="颜色类型"]').inputValue(), "gradient");
    assert.ok(await library.locator(".uc-editor").isVisible());
  });
  ui("mixed colors reorder visibly within their own keyboard section", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_library: [
        "#111111", "linear-gradient(90deg, #123456, #abcdef)", "#222222", "#333333",
        "linear-gradient(45deg, #111111, #eeeeee)", "#444444",
        "linear-gradient(180deg, #ffffff, #000000)", "#555555", "#666666",
      ],
    } },
  }, async ({ p }) => {
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const library = p.locator("#set-accent + .shared-colors");
    const values = (kind) => sectionColors(library, kind);
    await expandLibrary(p, "#set-accent + .shared-colors");
    await showKind(p, "#set-accent + .shared-colors", "solid");
    assert.deepEqual(await values("quick"), ["#111111", "#222222", "#333333"]);
    assert.deepEqual(await values("solid"), ["#444444", "#555555", "#666666"]);
    await library.locator('.uc-swatch[data-color="#555555"]').focus();
    await p.keyboard.press("Shift+ArrowLeft");
    await until(async () => values("solid"), ["#555555", "#444444", "#666666"],
      "single keyboard step moves past interleaved gradient");
    assert.deepEqual(await values("quick"), ["#111111", "#222222", "#333333"],
      "reordering within remainder cannot alter quick colors");
    await p.keyboard.press("Shift+ArrowLeft");
    assert.deepEqual(await values("solid"), ["#555555", "#444444", "#666666"],
      "keyboard stops at section boundary");
    await library.locator('.uc-swatch[data-color="#222222"]').focus();
    await p.keyboard.press("Shift+ArrowLeft");
    await until(async () => values("quick"), ["#222222", "#111111", "#333333"],
      "quick keyboard sorting moves to the visually adjacent color");
    await showKind(p, "#set-accent + .shared-colors", "gradient");
    assert.deepEqual(await values("quick"), ["linear-gradient(90deg, #123456, #abcdef)", "linear-gradient(45deg, #111111, #eeeeee)"],
      "gradient quick colors are untouched");
  });

  ui("dragging into quick adds one and dragging out removes one; different-type drops are rejected", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_layout: "rows", color_library: [
        "#111111", "#222222", "#333333", "#444444", "#555555",
        "linear-gradient(90deg, #aaaaaa, #bbbbbb)", "#666666",
        "linear-gradient(45deg, #cccccc, #dddddd)",
      ],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const library = p.locator("#set-accent + .shared-colors");
    await expandLibrary(p, "#set-accent + .shared-colors");
    const stored = async () => (await h.stored()).settings.color_library;
    const quick = async () => (await h.stored()).settings.quick_colors;
    const heading = (section, kind = section) =>
      library.locator(`.uc-kind-title[data-section="${section}"][data-kind="${kind}"]`);
    assert.deepEqual(await library.locator(".uc-kind-title").allTextContents(), [
      "纯色快捷（收起时显示）", "纯色", "渐变快捷（收起时显示）", "渐变色", "材质快捷（收起时显示）", "材质色",
    ], "the rows layout shows all three kinds at once");
    const before = await stored();
    const firstSolid = library.locator('.uc-preset[data-color="#666666"]');
    const gradient = library.locator('.uc-preset[data-color="linear-gradient(90deg, #aaaaaa, #bbbbbb)"]');
    await gradient.dragTo(firstSolid);
    assert.deepEqual(await stored(), before, "gradient onto solid is rejected without mutating storage");
    await firstSolid.dragTo(heading("gradient"));
    assert.deepEqual(await stored(), before, "solid onto gradient heading is rejected");
    await gradient.dragTo(heading("quick", "solid"));
    assert.equal(await quick(), null, "a gradient cannot go into the solid quick bar");
    await gradient.dragTo(heading("quick", "gradient"));
    await until(quick, ["#111111", "#222222", "#333333", "#444444", "#555555",
      "linear-gradient(90deg, #aaaaaa, #bbbbbb)"], "dragging to the gradient quick heading adds a quick gradient");
    assert.deepEqual(await stored(), before, "the library order does not change");
    assert.equal(await p.inputValue("#set-quick-limit"), "", "dragging never changes the limit");
    await library.locator('.uc-preset[data-color="#111111"]').dragTo(heading("solid"));
    await until(quick, ["#222222", "#333333", "#444444", "#555555", "linear-gradient(90deg, #aaaaaa, #bbbbbb)"],
      "dragging a quick solid into its category removes one quick color and pulls nothing in");
    assert.deepEqual(await stored(), before, "it goes back to where it was in the library");
    assert.deepEqual(await sectionColors(library, "solid"), ["#111111", "#666666"]);
    await library.locator('.uc-preset[data-color="#666666"]').dragTo(heading("solid"));
    await until(async () => sectionColors(library, "solid"), ["#666666", "#111111"],
      "a color dropped on its own heading goes first in its type");
    await library.locator(".uc-more").click();
    assert.deepEqual(await library.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.color)), await quick());
  });

  ui("at the limit picked in the settings, a dropped color takes the last quick place", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, quick_color_count: 6, quick_color_limit: 6, color_library: [
        "#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777", "#888888",
      ],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.equal(await p.inputValue("#set-quick-limit"), "6");
    const library = p.locator("#set-accent + .shared-colors");
    await expandLibrary(p, "#set-accent + .shared-colors");
    await library.locator('.uc-preset[data-color="#888888"]').dragTo(
      library.locator('.uc-kind-title[data-section="quick"]'));
    await until(async () => (await h.stored()).settings.quick_colors,
      ["#111111", "#222222", "#333333", "#444444", "#555555", "#888888"],
      "the sixth quick color makes room for the dropped one");
    assert.deepEqual(await sectionColors(library, "solid"), ["#666666", "#777777"],
      "the pushed-out color is back in its old place");
  });

  ui("with fewer colors than the quick count, dragging one out leaves one less quick color", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, quick_color_count: 10, color_library: ["#111111", "#222222", "#333333"],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const library = p.locator("#set-accent + .shared-colors");
    await expandLibrary(p, "#set-accent + .shared-colors");
    await library.locator('.uc-preset[data-color="#111111"]').dragTo(
      library.locator('.uc-kind-title[data-section="solid"]'));
    await until(async () => (await h.stored()).settings.quick_colors, ["#222222", "#333333"]);
    assert.deepEqual((await h.stored()).settings.color_library, ["#111111", "#222222", "#333333"]);
  });

  ui("many quick colors still leave the other sections in view", {
    seed: { ...seed({ "": { a: "文字", b: "文本" } }), settings: {
      ...SETTINGS, tab_groups: true, quick_color_count: 10, color_library: [
        "#111111", "#222222", "#333333", "#444444", "#555555",
        "#666666", "#777777", "#888888", "#999999", "#aaaaaa", "#bbbbbb",
      ],
    } },
  }, async ({ p }) => {
    await p.click("#tabs .tab:nth-child(1)", { button: "right" });
    await p.click('#ctx button[data-act="group-new"]');
    await expandLibrary(p, "#ge-colors .shared-colors");
    const inView = await p.locator("#ge-colors .uc-presets").evaluate((box) =>
      box.querySelector('.uc-kind-title[data-section="solid"]').getBoundingClientRect().bottom <=
        box.getBoundingClientRect().bottom);
    assert.ok(inView, "the 纯色 heading shows below ten quick colors without scrolling");
  });

  ui("the quick color limit previews before saving, cancel restores it, and it never changes the count", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, quick_color_count: 8, color_library: [
        "#111111", "#222222", "#333333", "#444444", "#555555",
        "#666666", "#777777", "#888888", "#999999", "#aaaaaa",
      ],
    } },
  }, async (h) => {
    const { p } = h;
    const palette = p.locator("#set-accent + .shared-colors");
    const visible = () => palette.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((node) => node.dataset.color));
    const colors = ["#111111", "#222222", "#333333", "#444444", "#555555",
      "#666666", "#777777", "#888888", "#999999", "#aaaaaa"];
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.equal(await p.inputValue("#set-quick-limit"), "", "no limit by default");
    assert.deepEqual(await visible(), colors.slice(0, 8));
    await p.fill("#set-quick-limit", "3");
    assert.deepEqual(await visible(), colors.slice(0, 3), "quick swatches follow the limit immediately");
    assert.equal((await h.stored()).settings.quick_color_limit, 0, "preview does not save");

    await p.click("#set-cancel");
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.equal(await p.inputValue("#set-quick-limit"), "", "cancel discards the previewed limit");
    assert.deepEqual(await visible(), colors.slice(0, 8));
    await p.fill("#set-quick-limit", "6");
    await p.click("#set-save");
    await until(async () => (await h.stored()).settings.quick_color_limit, 6);
    assert.equal((await h.stored()).settings.quick_color_count, 8, "the limit does not change the count");
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.deepEqual(await visible(), colors.slice(0, 6), "the saved limit is used after reopening");
  });

  ui("clearing the quick color limit previews and saves no limit", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, quick_color_count: 8, quick_color_limit: 3, color_library: [
        "#111111", "#222222", "#333333", "#444444", "#555555",
        "#666666", "#777777", "#888888", "#999999", "#aaaaaa",
      ],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const quick = p.locator("#set-accent + .shared-colors .uc-preset:visible");
    assert.equal(await quick.count(), 3);
    await p.fill("#set-quick-limit", "");
    assert.equal(await quick.count(), 8, "an empty field previews no limit");
    await p.click("#set-save");
    await until(async () => (await h.stored()).settings.quick_color_limit, 0);
  });

  ui("eight quick colors wrap, and dragging one out persists across pickers and reloads", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, quick_color_count: 8, color_library: [
        "#111111", "#222222", "#333333", "#444444", "#555555",
        "#666666", "#777777", "#888888", "#999999", "#aaaaaa",
      ],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const accent = p.locator("#set-accent + .shared-colors");
    const visible = (root) => root.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((el) => el.dataset.color));
    assert.deepEqual(await visible(accent), [
      "#111111", "#222222", "#333333", "#444444", "#555555",
      "#666666", "#777777", "#888888",
    ]);
    const positions = await accent.locator(".uc-presets").evaluate((el) => {
      const swatches = el.querySelectorAll(".uc-preset");
      return { quickRows: el.style.getPropertyValue("--uc-quick-rows"),
        first: swatches[0].getBoundingClientRect().top,
        sixth: swatches[5].getBoundingClientRect().top,
        toggle: el.querySelector(".uc-more").getBoundingClientRect().top };
    });
    assert.ok(positions.sixth > positions.first && positions.toggle === positions.first,
      "more button remains on the first row; additional quick colors wrap");
    assert.equal(positions.quickRows, "2", "expanded palette allows for a second quick row");
    await expandLibrary(p, "#set-accent + .shared-colors");
    assert.deepEqual(await accent.locator(".uc-kind-title").allTextContents(),
      ["快捷（收起时显示）", "纯色"]);
    await accent.locator('.uc-preset[data-color="#333333"]').dragTo(
      accent.locator('.uc-kind-title[data-section="solid"]'));
    await until(async () => (await h.stored()).settings.quick_colors?.length, 7,
      "dragging out of a longer quick section removes one quick color");
    assert.deepEqual(await sectionColors(accent, "solid"), ["#333333", "#999999", "#aaaaaa"],
      "it is back in its old place, ahead of the later solids");
    await accent.locator(".uc-more").click();
    assert.deepEqual(await visible(accent), [
      "#111111", "#222222", "#444444", "#555555",
      "#666666", "#777777", "#888888",
    ]);

    await p.reload();
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    const find = p.locator("#set-find-color + .shared-colors");
    assert.deepEqual(await visible(find), [
      "#111111", "#222222", "#444444", "#555555",
      "#666666", "#777777", "#888888",
    ], "other pickers share the persisted quick count and order");
  });

  ui("the only quick color can be dragged out, leaving the bar empty, and the limit stops at the library size", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, quick_color_count: 1, color_library: ["#111111", "#222222", "#333333", "#444444"],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const palette = p.locator("#set-accent + .shared-colors");
    const visible = () => palette.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((el) => el.dataset.color));
    assert.deepEqual(await visible(), ["#111111"]);
    await expandLibrary(p, "#set-accent + .shared-colors");
    await palette.locator('.uc-preset[data-color="#111111"]').dragTo(
      palette.locator('.uc-kind-title[data-section="solid"]'));
    await until(async () => (await h.stored()).settings.quick_colors, [],
      "nothing takes the place of the dragged-out color");
    await palette.locator(".uc-more").click();
    assert.deepEqual(await visible(), []);
    assert.equal(await palette.locator(".uc-presets .muted").textContent(), "点 ＋ 把颜色拖进快捷栏");
    const [hint, more] = await Promise.all([palette.locator(".uc-presets .muted"), palette.locator(".uc-more")]
      .map((node) => node.boundingBox()));
    assert.ok(hint.x + hint.width <= more.x, "the hint sits left of ＋ instead of under it");

    await p.fill("#set-quick-limit", "999");
    await p.click("#set-save");
    await until(async () => (await h.stored()).settings.quick_color_limit, 128,
      "the limit stops at the 128 colors a library can hold");
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.equal(await p.inputValue("#set-quick-limit"), "128");
    assert.deepEqual(await visible(), [], "raising the limit does not add quick colors");
  });

  ui("dragging a quick color to its type heading puts it back where it was", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_library: [
        "#111111", "#222222", "#333333", "#444444", "#555555",
        "linear-gradient(90deg, #aaaaaa, #bbbbbb)", "#777777", "#888888",
      ],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const library = p.locator("#set-accent + .shared-colors");
    await expandLibrary(p, "#set-accent + .shared-colors");
    await library.locator('.uc-preset[data-color="#222222"]').dragTo(
      library.locator('.uc-kind-title[data-section="solid"]'));
    await until(async () => (await h.stored()).settings.quick_colors,
      ["#111111", "#333333", "#444444", "#555555"], "quick shrinks instead of pulling in the gradient");
    assert.deepEqual((await h.stored()).settings.color_library, [
      "#111111", "#222222", "#333333", "#444444", "#555555",
      "linear-gradient(90deg, #aaaaaa, #bbbbbb)", "#777777", "#888888",
    ], "the library order is untouched");
    const solids = await library.locator(".uc-presets").evaluate((el) => {
      let section = "";
      return [...el.children].flatMap((node) => {
        if (node.classList.contains("uc-kind-title")) { section = node.dataset.section; return []; }
        return section === "solid" && node.classList.contains("uc-preset") ? [node.dataset.color] : [];
      });
    });
    assert.deepEqual(solids, ["#222222", "#777777", "#888888"]);
    await library.locator(".uc-more").click();
    assert.deepEqual(await library.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((el) => el.dataset.color)), ["#111111", "#333333", "#444444", "#555555"]);
  });

  ui("empty libraries show a readable hint in both collapsed and expanded modes", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, color_library: [] } },
  }, async ({ p }) => {
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const library = p.locator("#set-accent + .shared-colors");
    const check = async () => library.locator(".uc-presets > .muted").evaluate((el) => {
      const hint = el.getBoundingClientRect(), grid = el.parentElement.getBoundingClientRect();
      const computed = getComputedStyle(el);
      return { text: el.textContent, hintWidth: hint.width, gridWidth: grid.width,
        height: hint.height, lineHeight: Number.parseFloat(computed.lineHeight) ||
          Number.parseFloat(computed.fontSize) * 1.4 };
    });
    const collapsed = await check();
    assert.equal(collapsed.text, "还没有保存的颜色");
    assert.ok(collapsed.hintWidth > 100 && collapsed.hintWidth <= collapsed.gridWidth,
      "empty hint uses most of the row instead of a 31px cell");
    await library.locator(".uc-more").click();
    const expanded = await check();
    assert.ok(expanded.hintWidth > 100 && expanded.height < expanded.lineHeight * 2.5,
      "expanded hint remains readable without vertical word wrapping");
  });

  ui("drag reordering in find color does not steal focus into the outline picker", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_library: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    const library = p.locator("#set-find-color + .shared-colors");
    await expandLibrary(p, "#set-find-color + .shared-colors");
    const dragged = library.locator('.uc-preset[data-color="#222222"]');
    await dragged.locator(".uc-swatch").focus();
    await dragged.dragTo(library.locator('.uc-preset[data-color="#111111"]'));
    await until(async () => (await h.stored()).settings.quick_colors?.[0], "#222222");
    const focus = await p.evaluate(() => ({
      color: document.activeElement.dataset.color,
      picker: document.activeElement.closest(".shared-colors")?.previousElementSibling?.id,
    }));
    assert.deepEqual(focus, { color: "#222222", picker: "set-find-color" },
      "refreshSharedColors must not move focus to the later outline picker");
  });
});

describe("v0.3.5 editable color library", () => {
  ui("built-in solid and gradient colors can be edited without changing colors already in use", {
    seed: { ...seed({ "": { 页: "正文" } }), settings: { ...SETTINGS, accent: "#3b82f6", color_presets: ["#123abc"] } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, "#set-accent + .shared-colors");
    const palette = p.locator("#set-accent + .shared-colors");
    assert.ok(await palette.locator('.uc-swatch[data-color="#123abc"]').isVisible(), "previously saved colors were migrated");
    const solid = palette.locator('.uc-swatch[data-color="#3b82f6"]');
    await solid.click({ button: "right" });
    await palette.locator('input[aria-label="节点 1 颜色"]').fill("#abcdef");
    await palette.locator(".uc-editor .primary").click();
    await until(async () => (await h.stored())?.settings?.color_library?.includes("#abcdef"), true, "edited solid is persisted");
    assert.equal(await palette.locator('.uc-swatch[data-color="#3b82f6"]').count(), 0, "old solid preset has gone");
    assert.equal((await h.stored()).settings.accent, "#3b82f6", "editing the library does not recolor the existing accent");

    const oldGradient = "linear-gradient(135deg, #5fb4ff, #d66cf0)";
    await showKind(p, "#set-accent + .shared-colors", "gradient");
    await palette.locator('.uc-swatch[data-color="' + oldGradient + '"]').click({ button: "right" });
    await palette.locator('input[aria-label="渐变角度"]').fill("210");
    await palette.locator('input[aria-label="渐变角度"]').dispatchEvent("change");
    await palette.locator(".uc-editor .uc-actions button").first().click();
    await palette.locator('input[aria-label="节点 2 颜色"]').fill("#123abc");
    await palette.locator('input[aria-label="节点 2 位置"]').fill("35");
    await palette.locator('input[aria-label="节点 2 位置"]').dispatchEvent("change");
    await palette.locator(".uc-editor .primary").click();
    const edited = "linear-gradient(210deg, #5fb4ff 0%, #123abc 35%, #d66cf0 100%)";
    await until(async () => (await h.stored())?.settings?.color_library?.includes(edited), true, "gradient direction and stops are persisted");
    assert.equal(await palette.locator('.uc-swatch[data-color="' + oldGradient + '"]').count(), 0);
    await p.reload();
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, "#set-accent + .shared-colors");
    assert.ok(await p.locator('#set-accent + .shared-colors .uc-swatch[data-color="' + edited + '"]').isVisible(),
      "the picker reopens on the 渐变 tab it was left on");
    await showKind(p, "#set-accent + .shared-colors", "solid");
    assert.ok(await p.locator('#set-accent + .shared-colors .uc-swatch[data-color="#123abc"]').isVisible(), "old saved colors remain after migration");
  });

  ui("drag and keyboard sorting choose the quick colors; deletion can be undone", {
    seed: { ...seed({ "": { 页: "正文" } }), settings: { ...SETTINGS,
      color_library: ["#112233", "#223344", "#334455", "#445566", "#556677", "#667788"] } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const palette = p.locator("#set-accent + .shared-colors");
    const quick = () => palette.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((el) => el.dataset.color));
    assert.deepEqual(await quick(), ["#112233", "#223344", "#334455", "#445566", "#556677"]);
    await expandLibrary(p, "#set-accent + .shared-colors");
    await palette.locator('.uc-preset[data-color="#667788"]').dragTo(palette.locator('.uc-preset[data-color="#112233"]'));
    await until(async () => (await h.stored()).settings.quick_colors?.[0], "#667788", "drag changes order");
    await palette.locator(".uc-more").click();
    assert.deepEqual(await quick(), ["#667788", "#112233", "#223344", "#334455", "#445566", "#556677"],
      "dragging a color into quick adds it in front without pushing another out");
    await expandLibrary(p, "#set-accent + .shared-colors");
    await palette.locator('.uc-swatch[data-color="#667788"]').focus();
    await p.keyboard.press("Shift+ArrowRight");
    await until(async () => (await h.stored()).settings.quick_colors.slice(0, 2),
      ["#112233", "#667788"], "keyboard reorders the same list");
    await palette.locator('.uc-swatch[data-color="#667788"]').hover();
    await palette.locator('.uc-preset[data-color="#667788"] .uc-delete').click();
    await until(async () => (await h.stored()).settings.quick_colors.includes("#667788"), false);
    assert.ok((await h.stored()).settings.color_library.includes("#667788"), "× in quick keeps the color in the library");
    assert.equal(await palette.locator(".uc-undo").textContent(), "撤销移出");
    await palette.locator(".uc-undo").click();
    await until(async () => (await h.stored()).settings.quick_colors.slice(0, 2),
      ["#112233", "#667788"], "undo restores the original position");
    await p.reload();
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    const edge = p.locator("#set-edge-color + .shared-colors");
    assert.deepEqual(await edge.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((el) => el.dataset.color)), ["#112233", "#667788", "#223344", "#334455", "#445566", "#556677"],
      "quick colors and their dragged count persist and are shared across settings entrances");
  });

  ui("group popup keeps action buttons on-screen with the color library and editor expanded", {
    seed: { ...seed({ "": { a: "文字", b: "文本" } }), settings: { ...SETTINGS, tab_groups: true } },
  }, async ({ p }) => {
    await p.click("#tabs .tab:nth-child(1)", { button: "right" });
    await p.click('#ctx button[data-act="group-new"]');
    await expandLibrary(p, "#ge-colors .shared-colors");
    const palette = p.locator("#ge-colors .shared-colors");
    await palette.locator(":scope > .uc-actions button").first().click();
    // 弹窗变高后由 ResizeObserver 在下一帧挪回屏幕里,机器忙时会晚一点
    for (const id of ["#ge-collapse", "#ge-ungroup"]) {
      await until(async () => {
        const rect = await p.locator(id).boundingBox();
        return !!rect && rect.y >= 0 && rect.y + rect.height <= 540;
      }, true, id + " remains visible");
    }
    const presets = await palette.locator(".uc-presets").evaluate((el) =>
      [el.clientHeight, el.scrollHeight]);
    assert.ok(presets[0] <= 115 && presets[1] > presets[0], "the expanded color grid scrolls internally");
  });

  ui("deleting the last color survives restart and restoring defaults requires confirmation", {
    seed: { ...seed({ "": { 页: "正文" } }), settings: { ...SETTINGS, accent: "#123abc", color_library: ["#123abc"] } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, "#set-accent + .shared-colors");
    const palette = p.locator("#set-accent + .shared-colors");
    // 快捷栏里的 × 先移出快捷栏，回到纯色里再按 × 才从颜色库删掉
    await palette.locator('.uc-swatch[data-color="#123abc"]').hover();
    await palette.locator('.uc-swatch[data-color="#123abc"]').locator("..").locator(".uc-delete").click();
    await until(async () => (await h.stored())?.settings?.quick_colors, [], "out of quick first");
    assert.deepEqual(await sectionColors(palette, "solid"), ["#123abc"]);
    await palette.locator('.uc-swatch[data-color="#123abc"]').hover();
    await palette.locator('.uc-swatch[data-color="#123abc"]').locator("..").locator(".uc-delete").click();
    await until(async () => (await h.stored())?.settings?.color_library, [], "the library can be fully cleared");
    assert.equal(await palette.locator(".uc-swatch").count(), 0);
    assert.equal((await h.stored()).settings.accent, "#123abc", "deleting a preset does not change the applied color");
    await p.reload();
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const reopened = p.locator("#set-accent + .shared-colors");
    assert.equal(await reopened.locator(".uc-swatch").count(), 0, "empty custom library does not restore built-ins");
    await expandLibrary(p, "#set-accent + .shared-colors");
    assert.ok(await reopened.locator(".uc-reset").isVisible(), "reset shows without opening the editor");
    await reopened.locator(".uc-reset").click();
    assert.ok(await p.isVisible("#dialog"), "reset needs confirmation");
    await p.click("#dialog-ok");
    await until(async () => (await h.stored())?.settings?.color_library?.length, 10,
      "on the 纯色 tab only the ten default solids come back");
    assert.deepEqual((await h.stored()).settings.quick_colors,
      ["#d9822b", "#3b82f6", "#16a34a", "#8b5cf6", "#e5484d"], "quick colors are back to the default five");
    await until(async () => reopened.locator('.uc-swatch[data-color="#3b82f6"]').isVisible(), true, "restored colors render after save");
  });
});

describe("v0.3.4 picker regressions", () => {
  ui("positioned accents keep CSS gradient positions and a subtle selected swatch", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, accent: "linear-gradient(90deg, #112233 0%, #445566 21%, #778899 100%)" } },
  }, async ({ p }) => {
    assert.equal(await p.evaluate(() => document.documentElement.style.getPropertyValue("--accent-grad")), "linear-gradient(90deg, #112233 0%, #445566 21%, #778899 100%)");
    assert.deepEqual(await p.$$eval("#accent-svg-grad stop", (nodes) => nodes.map((x) => x.getAttribute("offset"))), ["0%", "21%", "100%"]);
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.equal(await p.locator("#settings .accent-custom").count(), 0);
    const layout = await p.$eval("#set-accent + .shared-colors", (el) => {
      const center = (node) => {
        const r = node.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      };
      return [getComputedStyle(el).display, center(el.querySelector(".uc-title")), center(el.querySelector(".uc-kinds")),
        el.querySelector(".uc-presets").getBoundingClientRect().top - el.querySelector(".uc-head").getBoundingClientRect().bottom];
    });
    assert.equal(layout[0], "grid", "settings palettes are compact");
    assert.ok(Math.abs(layout[1] - layout[2]) < 3, "the 纯色 | 渐变 | 材质 switch sits beside the library heading");
    assert.ok(layout[3] >= -1, "quick swatches start below the heading row");
    assert.equal(await p.locator("#set-accent + .shared-colors > .uc-actions").isVisible(), false,
      "editing controls stay hidden until the library opens");
    await expandLibrary(p, "#set-accent + .shared-colors");
    await showKind(p, "#set-accent + .shared-colors", "solid"); // 当前是渐变主题色，打开时停在渐变
    await p.click('#set-accent + .shared-colors .uc-swatch[data-color="#3b82f6"]');
    assert.equal(await p.$eval("#set-accent + .shared-colors .uc-swatch.on", (el) => getComputedStyle(el).outlineWidth), "1px");
  });

  ui("shared swatches and small delete buttons fit inside group and format popup menus", {
    seed: { ...seed({ "": { a: "文字", b: "文本" } }), settings: { ...SETTINGS, tab_groups: true, color_presets: ["#123abc"] } },
  }, async ({ p }) => {
    const check = async (sel) => {
      const size = await p.$eval(sel, (el) => {
        const a = el.querySelector(".uc-swatch").getBoundingClientRect(), b = el.querySelector(".uc-delete").getBoundingClientRect();
        return [Math.round(a.width), Math.round(a.height), Math.round(b.width), Math.round(b.height)];
      });
      assert.deepEqual(size, [27, 25, 15, 15]);
    };
    await p.click("#tabs .tab:nth-child(1)", { button: "right" });
    await p.click('#ctx button[data-act="group-new"]');
    await expandLibrary(p, "#ge-colors .shared-colors");
    await check("#ge-colors .uc-preset");
    assert.equal(await p.$eval("#ge-colors .uc-actions button", (el) => getComputedStyle(el).borderTopWidth), "1px");
    assert.equal(await p.locator("#ge-colors .ge-custom").count(), 0);
    await p.keyboard.press("Escape");
    await p.click('#format-bar [data-cmd="bg"]');
    await expandLibrary(p, ".fb-pop .shared-colors");
    await check(".fb-pop .uc-preset");
    assert.equal(await p.$eval(".fb-pop .uc-actions button", (el) => getComputedStyle(el).borderTopWidth), "1px");
  });

  ui("saved colors and the node editor support keyboard actions in settings, groups and format bar", {
    seed: { ...seed({ "": { a: "文字", b: "文本" } }), settings: { ...SETTINGS, tab_groups: true, color_presets: ["#123abc"] } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, "#set-accent + .shared-colors");
    const accent = p.locator("#set-accent + .shared-colors");
    await accent.locator('.uc-swatch[data-color="#123abc"]').focus();
    await p.keyboard.press("Enter");
    await accent.locator(".uc-actions button").first().focus();
    await p.keyboard.press("Enter");
    assert.ok(await accent.locator(".uc-editor").isVisible(), "Enter opens the same editor");
    await accent.locator(".uc-controls select").focus();
    await p.keyboard.press("ArrowDown");
    assert.equal(await accent.locator(".uc-controls select").inputValue(), "gradient", "keyboard changes the gradient mode");
    await p.click("#set-save");
    await until(() => h.stored().then((s) => s.settings.accent), "#123abc");

    await p.click("#tabs .tab:nth-child(1)", { button: "right" });
    await p.click('#ctx button[data-act="group-new"]');
    await expandLibrary(p, "#ge-colors .shared-colors");
    await p.locator('#ge-colors .uc-swatch[data-color="#123abc"]').focus();
    await p.keyboard.press("Space");
    await until(() => h.stored().then((s) => s.books[""].meta.groups[0].color), "#123abc", "space selects group color");
    await p.keyboard.press("Escape");
    assert.ok(await p.isHidden("#group-edit"), "Escape closes the group picker before editing");

    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("Home");
    await p.keyboard.press("Shift+End");
    await p.click('#format-bar [data-cmd="bg"]');
    await expandLibrary(p, ".fb-pop .shared-colors");
    await p.locator('.fb-pop .uc-swatch[data-color="#123abc"]').focus();
    await p.keyboard.press("Enter");
    await until(async () => (await h.editor()).includes("background-color: #123abc"), true, "enter applies format color");
  });

  ui("quick colors remain aligned and settings palettes expand without nested scrolling", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_library: Array.from({ length: 40 }, (_, i) => "#" + (0x123400 + i).toString(16)),
    } },
  }, async ({ p }) => {
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const root = p.locator("#set-accent + .shared-colors");
    assert.equal(await root.locator(".uc-more").getAttribute("aria-expanded"), "false");
    assert.equal(await root.locator(".uc-preset:visible").count(), 5, "five quick colors");
    assert.equal(await root.locator(".uc-swatch").count(), 5, "collapsed view renders only quick colors");
    await root.locator(".uc-more").click();
    assert.equal(await root.locator(".uc-preset:visible").count(), 40);
    assert.ok(await root.locator(".uc-presets").evaluate((el) => el.scrollHeight <= el.clientHeight + 1),
      "settings expand without a second vertical scroll area");
    const placement = await root.locator(".uc-more").evaluate((node) => {
      const root = node.closest(".uc-presets");
      const area = root.getBoundingClientRect(), button = node.getBoundingClientRect();
      return {
        right: area.right - button.right,
        top: button.top - area.top,
        fits: node.scrollHeight <= node.clientHeight,
        text: node.textContent,
      };
    });
    assert.ok(placement.right < 12 && placement.top < 12, "collapse button stays in the quick row's rightmost slot");
    assert.equal(placement.text, "−");
    assert.ok(placement.fits, "the expanded symbol does not wrap or overflow");
    await root.locator(".uc-more").click();
    assert.equal(await root.locator(".uc-preset:visible").count(), 5);
  });

  ui("fixed px length keeps the numeric input wide enough", async ({ p }) => {
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    await p.selectOption("#set-edge-length-unit", "px");
    await p.fill("#set-edge-length-number", "600");
    await p.locator("#set-edge-length-number").dispatchEvent("change");
    assert.equal(await p.inputValue("#set-edge-length-number"), "600");
    assert.ok(await p.$eval("#set-edge-length-number", (el) => el.getBoundingClientRect().width >= 80));
    assert.equal(await p.locator("#settings .accent-custom").count(), 0);
  });
});

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
    await settingsPage(p, "look");
    await p.locator("#settings").waitFor();
    await expandLibrary(p, "#set-accent + .shared-colors");
    await showKind(p, "#set-accent + .shared-colors", "gradient");
    await p.click('#set-accent + .shared-colors .uc-swatch[data-color="linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142, #51cf66, #4dabf7, #9775fa)"]');
    assert.equal(await p.locator("#set-accent").locator("..").locator(".accent-custom").count(), 0, "no duplicate legacy custom picker");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.accent, "linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142, #51cf66, #4dabf7, #9775fa)", "saved");
    assert.match(await marker(), /linear-gradient/, "the active tab's line is the gradient");
    // 置顶这种亮起来的图标,线条也是同一个渐变
    await p.locator("#btn-pin.on").waitFor(); // 默认就是置顶
    assert.match(await p.$eval("#btn-pin svg", (s) => getComputedStyle(s).stroke), /url\(.*#accent-svg-grad.*\)/, "the pinned icon is drawn with the gradient");
    assert.equal(await p.$$eval("#accent-svg-grad stop", (s) => s.length), 6, "all six rainbow colors");
    await p.click("#btn-pin");
    await p.locator("#btn-pin:not(.on)").waitFor();
    assert.equal(await p.$eval("#btn-pin svg", (s) => getComputedStyle(s).stroke), await p.$eval("#btn-pin", (b) => getComputedStyle(b).color), "off: back to the plain color");
    await p.click("#btn-pin");
    await p.locator("#btn-pin.on").waitFor();
    // 自定义的纯色
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, "#set-accent + .shared-colors");
    assert.ok(await p.locator('#set-accent + .shared-colors .uc-swatch.on[data-color="linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142, #51cf66, #4dabf7, #9775fa)"]').isVisible(), "the saved accent is marked");
    await expandLibrary(p, "#set-accent + .shared-colors");
    const picker = p.locator("#set-accent").locator("..").locator(".shared-colors");
    await picker.locator(":scope > .uc-actions button").first().click();
    await picker.locator("select").selectOption("solid");
    await picker.locator('input[aria-label="节点 1 颜色"]').fill("#123abc");
    await picker.locator(".uc-editor .uc-actions .primary").click();
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.accent, "#123abc", "a custom color");
    assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()), "#123abc");
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.click('#set-accent button[title="跟随风格"]');
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.accent, "", "back to the default");
    assert.equal(await marker(), "none");
  });

  ui("the active tab is highlighted with a top line, the whole tab or a border, as chosen in the settings", { seed: seed({ "": { 甲: "一", 乙: "二" } }) }, async (h) => {
    const { p } = h;
    const look = () => p.$eval(".tab.active", (t) => {
      const b = getComputedStyle(t, "::before");
      return { height: Math.round(parseFloat(b.height)), opacity: b.opacity, masked: (b.maskComposite || b.webkitMaskComposite || "") !== "" && b.maskImage !== "none" };
    });
    assert.deepEqual(await look(), { height: 3, opacity: "1", masked: false }, "a thin line on top by default");
    for (const [style, check] of [
      ["fill", (l) => l.height > 20 && l.opacity === "0.32" && !l.masked],
      ["border", (l) => l.height > 20 && l.opacity === "1" && l.masked],
      ["line", (l) => l.height === 3],
    ]) {
      await p.click("#btn-settings");
      await settingsPage(p, "look");
      await p.selectOption("#set-tab-style", style);
      await p.click("#set-save");
      await until(async () => (await h.stored())?.settings?.tab_style, style, `${style} is saved`);
      assert.ok(check(await look()), `${style}: ${JSON.stringify(await look())}`);
    }
  });

  ui("while the window is tucked into a screen edge a marker shows on the strip left on screen", { seed: seed({ "": { 页: "文字" } }) }, async (h) => {
    const { p } = h;
    const mark = () => p.$eval("#edge-mark", (m) => { const r = m.getBoundingClientRect(); return getComputedStyle(m).display === "none" ? null : [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
    assert.equal(await mark(), null, "no marker while the window is out");
    await p.evaluate(() => window.__mockEmit("edge-hidden", "top"));
    assert.deepEqual(await mark(), [0, 522, 440, 18], "default style (line + arrow) leaves an 18px strip");
    assert.equal(await p.isVisible("#edge-expand"), true, "the arrow strip can be clicked");
    await p.evaluate(() => window.__mockEmit("edge-hidden", "left"));
    assert.deepEqual(await mark(), [422, 0, 18, 540], "left edge");
    await p.evaluate(() => window.__mockEmit("edge-hidden", "right"));
    assert.deepEqual(await mark(), [0, 0, 18, 540], "right edge");
    await p.click("#edge-expand");
    assert.equal(await mark(), null, "clicking expand restores the window");

    const edgeVars = () => p.evaluate(() => [getComputedStyle(document.querySelector("#edge-mark")).getPropertyValue("--ec").trim(), document.documentElement.style.getPropertyValue("--edge-grad")]);
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    assert.equal(await p.inputValue("#set-edge-style"), "arrow", "line + arrow by default");
    assert.equal(await p.getAttribute("#set-edge-color button.on", "title"), "跟随强调色", "edge color follows the accent by default");
    await p.uncheck("#set-edge");
    assert.equal(await p.isDisabled("#set-edge-style"), true, "edge options are off while edge hiding is off");
    await p.check("#set-edge");
    // 仅细边 + 单独的渐变色
    await p.selectOption("#set-edge-style", "line");
    await expandLibrary(p, "#set-edge-color + .shared-colors");
    await showKind(p, "#set-edge-color + .shared-colors", "gradient");
    await p.click('#set-edge-color + .shared-colors .uc-swatch[data-color="linear-gradient(135deg, #5fb4ff, #d66cf0)"]');
    await p.click("#set-save");
    await until(() => h.stored().then((s) => [s.settings.edge_style, s.settings.edge_color]), ["line", "linear-gradient(135deg, #5fb4ff, #d66cf0)"]);
    await p.evaluate(() => window.__mockEmit("edge-hidden", "top"));
    assert.deepEqual(await mark(), [0, 538, 440, 2], "line style defaults to a 2px strip");
    assert.equal(await p.$eval("#edge-expand", (b) => getComputedStyle(b, "::before").display), "none", "no arrow in line style");
    assert.deepEqual(await edgeVars(), ["#5fb4ff", "linear-gradient(135deg, #5fb4ff, #d66cf0)"], "edge uses its own color");
    await p.evaluate(() => window.__mockEmit("edge-shown"));

    // 细边 + 悬浮按钮:平时细边,靠近时多露出一点并浮出按钮
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    await p.selectOption("#set-edge-style", "hover");
    await p.click('#set-edge-color button[title="跟随强调色"]');
    await p.click("#set-save");
    await until(() => h.stored().then((s) => [s.settings.edge_style, s.settings.edge_color]), ["hover", ""]);
    await p.evaluate(() => window.__mockEmit("edge-hidden", "left"));
    assert.deepEqual(await mark(), [438, 0, 2, 540], "hover style starts as a 2px edge");
    assert.equal(await p.$eval("#edge-expand", (b) => getComputedStyle(b, "::before").display), "none", "no button until the mouse comes near");
    assert.equal((await edgeVars())[1], "", "edge color follows the accent again");
    await p.evaluate(() => window.__mockEmit("edge-peek", true));
    assert.deepEqual(await mark(), [408, 0, 32, 540], "mouse near: the strip widens for the button");
    const btn = await p.$eval("#edge-expand", (b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    assert.deepEqual(btn, [20, 56], "floating button");
    await p.evaluate(() => window.__mockEmit("edge-peek", false));
    assert.deepEqual(await mark(), [438, 0, 2, 540], "mouse away: back to the slim edge");
    await p.evaluate(() => window.__mockEmit("edge-peek", true));
    await p.click("#edge-expand");
    assert.equal(await mark(), null, "clicking the floating button restores the window");
  });

  ui("edge line width, length and universal glow settings work across all modes", { seed: seed({ "": { 页: "文字" } }) }, async (h) => {
    const { p } = h;
    const mark = () => p.$eval("#edge-mark", (m) => {
      const r = m.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    });
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    assert.equal(await p.inputValue("#set-edge-line-width"), "2", "existing users default to 2px");
    assert.equal(await p.inputValue("#set-edge-line-length"), "100");
    assert.equal(await p.isChecked("#set-edge-glow"), false);
    await p.selectOption("#set-edge-style", "line");
    await p.$eval("#set-edge-line-width", (input) => {
      input.value = "7";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await p.$eval("#set-edge-line-length", (input) => {
      input.value = "45";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await p.check("#set-edge-glow");
    await expandLibrary(p, "#set-edge-color + .shared-colors");
    await showKind(p, "#set-edge-color + .shared-colors", "gradient");
    await p.click('#set-edge-color + .shared-colors .uc-swatch[data-color="linear-gradient(135deg, #5fb4ff, #d66cf0)"]');
    const previewGlow = await p.$eval("#set-edge-line-preview", (x) =>
      getComputedStyle(x).getPropertyValue("--preview-glow-color").trim()
    );
    assert.equal(previewGlow, "#5fb4ff", "preview glow uses edge color instead of accent color");
    assert.equal(await p.textContent("#set-edge-line-width-val"), "7 像素");
    assert.equal(await p.textContent("#set-edge-line-length-val"), "45%");
    assert.equal(await p.$eval("#set-edge-line-preview", (x) => x.classList.contains("glow")), true);
    await p.click("#set-save");
    await until(() => h.stored().then((s) =>
      [s.settings.edge_style, s.settings.edge_line_width, s.settings.edge_line_length, s.settings.edge_line_glow]),
      ["line", 7, 45, true], "the settings persist");
    await p.evaluate(() => window.__mockEmit("edge-hidden", "top"));
    assert.deepEqual(await mark(), [0, 533, 440, 7], "glow leaves the exposed strip at the selected 7px");
    const line = await p.$eval("#edge-mark > span", (x) => {
      const r = x.getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height), getComputedStyle(x).boxShadow];
    });
    assert.equal(line[0], 198, "line covers 45% of 440px");
    assert.equal(line[1], 7, "line remains 7px thick despite glow visibility");
    assert.match(line[2], /(?:rgba?\(|color\(srgb)/, "line has a glow shadow");
    await p.evaluate(() => window.__mockEmit("edge-shown"));
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    await p.selectOption("#set-edge-style", "arrow-only");
    assert.equal(await p.isVisible(".edge-line-option"), false, "arrow-only hides line-only controls");
    assert.equal(await p.isDisabled("#set-edge-glow"), false, "glow also applies to arrow-only");
    await p.click("#set-save");
    await until(() => h.stored().then((s) => s.settings.edge_style), "arrow-only");
    await p.evaluate(() => window.__mockEmit("edge-hidden", "right"));
    assert.deepEqual(await mark(), [0, 0, 18, 540]);
    assert.equal(await p.$eval("#edge-mark > span", (x) => getComputedStyle(x).display), "none", "arrow-only draws no line");
    const arrow = await p.$eval("#edge-expand", (b) => getComputedStyle(b, "::before").filter);
    assert.match(arrow, /drop-shadow/, "arrow-only has glow enabled");
    await p.evaluate(() => window.__mockEmit("edge-shown"));
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    await p.selectOption("#set-edge-style", "hover");
    await p.click("#set-save");
    await until(() => h.stored().then((s) => s.settings.edge_style), "hover");
    await p.evaluate(() => window.__mockEmit("edge-hidden", "left"));
    assert.deepEqual(await mark(), [433, 0, 7, 540], "glow does not widen the hidden line");
    await p.evaluate(() => window.__mockEmit("edge-peek", true));
    const glow = await p.$eval("#edge-expand", (b) => getComputedStyle(b).boxShadow);
    assert.match(glow, /(?:rgba?\(|color\(srgb)/, "hover reveal button has a glow");
    await p.evaluate(() => window.__mockEmit("edge-shown"));
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    await p.selectOption("#set-edge-style", "arrow");
    await p.$eval("#set-edge-line-width", (input) => {
      input.value = "12";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await p.click("#set-save");
    await until(() => h.stored().then((s) => [s.settings.edge_style, s.settings.edge_line_width]), ["arrow", 12]);
    await p.evaluate(() => window.__mockEmit("edge-hidden", "top"));
    const masked = await p.$eval("#edge-mark > span", (el) => {
      const s = getComputedStyle(el);
      return { height: Math.round(el.getBoundingClientRect().height), mask: s.maskImage || s.webkitMaskImage };
    });
    assert.equal(masked.height, 12);
    assert.match(masked.mask, /linear-gradient/, "thick line leaves a gap beneath the arrow");
    const arrowHit = await p.$eval("#edge-expand", (b) => Math.round(b.getBoundingClientRect().width));
    assert.equal(arrowHit, 198, "only the drawn 45% span is clickable");
    await p.evaluate(() => window.__mockEmit("edge-shown"));
  });

  ui("fixed pixel edge length keeps its px size and remembers previous percent", { seed: seed({ "": { 页: "内容" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    assert.equal(await p.inputValue("#set-edge-length-unit"), "percent", "old settings still use percent");
    await p.$eval("#set-edge-line-length", (el) => {
      el.value = "45";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await p.selectOption("#set-edge-length-unit", "px");
    assert.equal(await p.inputValue("#set-edge-line-length"), "120", "fixed mode starts at 120px");
    await p.fill("#set-edge-length-number", "100");
    await p.locator("#set-edge-length-number").dispatchEvent("change");
    assert.equal(await p.textContent("#set-edge-line-length-val"), "px", "the number is shown only once");
    await p.selectOption("#set-edge-length-unit", "percent");
    assert.equal(await p.inputValue("#set-edge-line-length"), "45", "percent value survives mode switch");
    await p.selectOption("#set-edge-length-unit", "px");
    await p.click("#set-save");
    await until(() => h.stored().then((s) => [
      s.settings.edge_line_length_unit, s.settings.edge_line_length_px, s.settings.edge_line_length
    ]), ["px", 100, 45]);
    await p.evaluate(() => window.__mockEmit("edge-hidden", "top"));
    const size = await p.$eval("#edge-mark > span", (el) => Math.round(el.getBoundingClientRect().width));
    assert.equal(size, 100, "line keeps a fixed 100px length inside the 440px floating window");
    await p.evaluate(() => window.__mockEmit("edge-shown"));
    await p.reload();
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    assert.equal(await p.inputValue("#set-edge-length-unit"), "px");
    assert.equal(await p.inputValue("#set-edge-line-length"), "100");
  });

  ui("the floating icon is off by default; when on, the top bar gets a button that collapses the window", { seed: seed({ "": { 页: "文字" } }) }, async (h) => {
    const { p } = h;
    assert.equal(await p.isVisible("#btn-ball"), false, "no collapse button by default");
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    assert.equal(await p.isChecked("#set-ball"), false, "off by default");
    assert.equal(await p.isDisabled("#set-ball-size"), true, "options are off while the icon is off");
    await p.check("#set-ball");
    assert.equal(await p.isChecked('input[name="set-ball-icon"][value="app"]'), true, "app icon by default");
    assert.equal(await p.isDisabled('input[name="set-ball-icon"][value="custom"]'), true, "no custom image picked yet");
    assert.equal(await p.getAttribute("#set-ball-color button.on", "title"), "原色", "original colors by default");
    assert.equal(await p.$eval("#set-ball-preview .tint", (t) => t.hidden), true, "no tint by default");
    await p.fill("#set-ball-size", "64");
    await p.fill("#set-ball-opacity", "80");
    await p.selectOption("#set-ball-open", "dblclick");
    await expandLibrary(p, "#set-ball-color + .shared-colors");
    await showKind(p, "#set-ball-color + .shared-colors", "gradient");
    await p.click('#set-ball-color + .shared-colors .uc-swatch[data-color="linear-gradient(135deg, #5fb4ff, #d66cf0)"]');
    const preview = await p.$eval("#set-ball-preview", (el) => [Math.round(el.getBoundingClientRect().width), el.querySelector(".tint").hidden, el.querySelector(".tint").style.background, el.style.opacity]);
    assert.equal(preview[3], "0.8", "preview follows the opacity");
    assert.equal(preview[0], 64, "preview follows the size");
    assert.equal(preview[1], false, "preview shows the tint");
    assert.match(preview[2], /linear-gradient/, "gradient tint");
    // 选一张自定义图片
    await p.evaluate(() => (window.__mockControl = { pickBallImage: "data:image/png;base64,iVBORw0KGgo=" }));
    await p.click("#set-ball-pick");
    assert.equal(await p.isChecked('input[name="set-ball-icon"][value="custom"]'), true, "picking an image selects it");
    assert.equal(await p.getAttribute("#set-ball-preview img", "src"), "data:image/png;base64,iVBORw0KGgo=");
    await p.evaluate(() => (window.__mockControl.ballImage = "data:image/png;base64,cmVmcmVzaGVk"));
    await p.click("#set-ball-refresh");
    assert.equal(await p.getAttribute("#set-ball-preview img", "src"), "data:image/png;base64,cmVmcmVzaGVk", "manual reload updates preview");
    await p.click("#set-save");
    await until(() => h.stored().then((s) => [s.settings.ball_enabled, s.settings.ball_size, s.settings.ball_icon, s.settings.ball_color, s.settings.ball_opacity, s.settings.ball_open]), [true, 64, "custom", "linear-gradient(135deg, #5fb4ff, #d66cf0)", 80, "dblclick"]);
    assert.equal(await p.isVisible("#btn-ball"), true, "the top bar now has the collapse button");
    await p.click("#btn-ball");
    await until(() => p.evaluate(() => window.__mockControl.collapsed), 1, "clicking it collapses the window to the icon");

    await p.click("#btn-settings");
    await settingsPage(p, "window");
    await p.uncheck("#set-ball");
    await p.click("#set-save");
    await until(() => h.stored().then((s) => s.settings.ball_enabled), false);
    assert.equal(await p.isVisible("#btn-ball"), false, "turning it off removes the button");
  });

  ui("text can get a gradient color, saved as a background-clip span", { seed: seed({ "": { 页: "渐变" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+Home");
    await until(h.selection, "渐变");
    await p.click('#format-bar [data-cmd="color"]');
    await expandLibrary(p, ".fb-pop");
    await showKind(p, ".fb-pop", "gradient");
    await p.click('.fb-pop .uc-swatch[data-color="linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142, #51cf66, #4dabf7, #9775fa)"]');
    const md =
      '<span style="color: #ff5f6d; background-image: linear-gradient(135deg, #ff5f6d, #ffa94d, #f5d142, #51cf66, #4dabf7, #9775fa); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent">渐变</span>';
    assert.equal(await h.editor(), md);
    await until(() => h.mockFile("", "页"), md, "saved");
    await p.reload();
    await p.locator('#editor span[data-color^="linear-gradient"]').waitFor();
    assert.equal(await h.editor(), md, "read back the same after a restart");
  });
});


// ---------- P0：保存与退出安全 ----------
describe("P0 persistence safety", () => {
  ui("a failed note write retains dirty content and a later retry saves it", { seed: seed({ "": { 页: "原内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => {
      window.__mockControl = { fail: { save_note: "模拟磁盘已满" } };
      const note = window.__minipad.state.books[0].notes[0];
      note.content = "尚未保存的内容";
      note.dirty = true;
    });
    await p.keyboard.press("Control+s");
    await until(() => p.textContent("#st-save"), "保存失败:Error: 模拟磁盘已满", "write failure displayed");
    assert.equal(await h.mockFile("", "页"), "原内容", "failed save did not change disk");
    assert.equal(await p.evaluate(() => window.__minipad.state.books[0].notes[0].dirty), true, "dirty flag survives failure");
    await p.evaluate(() => delete window.__mockControl.fail.save_note);
    await p.keyboard.press("Control+s");
    await until(() => h.mockFile("", "页"), "尚未保存的内容", "retry persisted the content");
    assert.equal(await p.evaluate(() => window.__minipad.state.books[0].notes[0].dirty), false);
  });

  ui("a slow write is followed by newer edits without losing the latest content", { seed: seed({ "": { 页: "旧内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => {
      window.__mockControl = { delay: { save_note: 250 } };
      const note = window.__minipad.state.books[0].notes[0];
      note.content = "第一版";
      note.dirty = true;
    });
    await p.keyboard.press("Control+s");
    await p.evaluate(() => {
      const note = window.__minipad.state.books[0].notes[0];
      note.content = "第二版";
      note.dirty = true;
    });
    await p.keyboard.press("Control+s");
    await until(() => h.mockFile("", "页"), "第二版", "newer edit persisted after first write");
    assert.equal(await p.evaluate(() => window.__minipad.state.books[0].notes[0].dirty), false);
  });
  ui("the quit dialog can cancel and explicitly force exit after a write error", { seed: seed({ "": { 页: "原内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => {
      window.__mockControl = { fail: { save_note: "模拟保存失败" }, calls: [] };
      const note = window.__minipad.state.books[0].notes[0];
      note.content = "未保存";
      note.dirty = true;
      window.__mockEmit("before-quit", 1);
    });
    await p.locator("#dialog").waitFor();
    assert.match(await p.textContent("#dialog-msg"), /有 1 页没保存成功.*模拟保存失败/);
    await p.click("#dialog-cancel");
    assert.equal(await p.evaluate(() => window.__mockControl.calls.includes("quit_app")), false);
    assert.ok(await p.evaluate(() => window.__mockControl.calls.includes("quit_cancel")));
    await p.evaluate(() => window.__mockEmit("before-quit", 2));
    await p.locator("#dialog").waitFor();
    await p.click("#dialog-ok");
    await until(() => p.evaluate(() => window.__mockControl.calls.includes("quit_app")), true, "confirmed force exit");
    assert.equal(await h.mockFile("", "页"), "原内容", "failed write never overwrote the file");
  });

  ui("a stalled save prompts without exiting automatically", { seed: seed({ "": { 页: "原内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => {
      window.__mockControl = { delay: { save_note: 300 }, quitTimeoutMs: 40, calls: [] };
      const note = window.__minipad.state.books[0].notes[0];
      note.content = "等待写入";
      note.dirty = true;
      window.__mockEmit("before-quit", 11);
    });
    await p.locator("#dialog").waitFor();
    assert.match(await p.textContent("#dialog-msg"), /保存等待超过 10 秒/);
    await p.click("#dialog-cancel");
    assert.equal(await p.evaluate(() => window.__mockControl.calls.includes("quit_app")), false);
    await until(() => h.mockFile("", "页"), "等待写入", "background save eventually completes");
    await p.evaluate(() => {
      const note = window.__minipad.state.books[0].notes[0];
      note.content = "下一次写入";
      note.dirty = true;
      window.__mockEmit("before-quit", 12);
    });
    await p.locator("#dialog").waitFor();
    await p.click("#dialog-ok");
    await until(() => p.evaluate(() => window.__mockControl.calls.includes("quit_app")), true);
  });

  ui("one failed page does not prevent a second page from being saved", { seed: seed({ "": { 甲: "一", 乙: "二" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => {
      window.__mockControl = { failNote: { 甲: "这一页无法写入" } };
      for (const note of window.__minipad.state.books[0].notes) {
        note.content += "新";
        note.dirty = true;
      }
    });
    await p.keyboard.press("Control+s");
    await until(() => h.mockFile("", "乙"), "二新", "healthy page saved");
    assert.equal(await h.mockFile("", "甲"), "一", "failed page left intact");
    assert.deepEqual(await p.evaluate(() => window.__minipad.state.books[0].notes.map((n) => n.dirty)), [true, false]);
  });

  ui("an unreadable notebook stays visible, but a truly deleted one disappears", { seed: seed({ "": { 首页: "文字" }, 工作: { 周报: "内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { unreadableBook: ["工作"] }; });
    await h.sync();
    assert.ok((await h.items()).some((i) => i.book === "工作") || (await h.listBooks()).some((i) => i.book === "工作"));
    await p.evaluate(() => delete window.__mockBooks["工作"]);
    await h.sync();
    await until(async () => (await h.listBooks()).some((i) => i.book === "工作"), false, "deleted book disappears");
  });

  ui("unreadable page stays read-only and recovers after a successful sync", { seed: seed({ "": { 好页: "正常内容", 坏页: "磁盘原内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { unreadable: { "": { 坏页: "模拟访问被拒绝" } }, calls: [] }; });
    await h.sync();
    await until(() => p.locator(".tab.unreadable").count(), 1, "warning tab appears");
    await h.tab("坏页").click();
    assert.ok(await p.isVisible("#read-error"));
    assert.match(await p.textContent("#read-error"), /这一页读取失败:模拟访问被拒绝/);
    assert.equal(await p.getAttribute("#editor .ProseMirror", "contenteditable"), "false");
    await p.keyboard.type("不能输入");
    await p.keyboard.press("Control+s");
    assert.equal(await h.mockFile("", "坏页"), "磁盘原内容");
    assert.equal(await p.evaluate(() => window.__mockControl.calls.filter((x) => x === "save_note").length), 0);
    await p.evaluate(() => delete window.__mockControl.unreadable[""].坏页);
    await h.sync();
    await until(() => p.isHidden("#read-error"), true, "page becomes editable again");
    assert.equal(await p.getAttribute("#editor .ProseMirror", "contenteditable"), "true");
    assert.equal(await h.editor(), "磁盘原内容");
    await h.tab("好页").click();
    await p.locator("#editor .ProseMirror").click();
    await p.keyboard.press("End");
    await p.keyboard.type("追加");
    await until(() => h.mockFile("", "好页"), "正常内容追加", "healthy page still saves");
  });

  ui("changing notes folder lets the user choose whether to copy existing pages", { seed: seed({ "": { 页: "原内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = {}; });
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    assert.equal(await p.isChecked("#set-migrate-notes"), true);
    assert.equal(await p.isDisabled("#set-migrate-notes"), true);
    await p.fill("#set-dir", "D:\\NewNotes");
    assert.equal(await p.isDisabled("#set-migrate-notes"), false);
    await p.click("#set-save");
    await until(() => p.evaluate(() => window.__mockControl.migrationRequested), true);
    assert.equal(await h.mockFile("", "页"), "原内容", "existing notes still available after folder change");
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await p.fill("#set-dir", "D:\\OtherNotes");
    await p.uncheck("#set-migrate-notes");
    await p.click("#set-save");
    await until(() => p.evaluate(() => window.__minipad.state.settings.notes_dir), "D:\\OtherNotes");
    assert.equal(await p.evaluate(() => window.__mockControl.migrationRequested), true, "previous copy recorded");
  });

  ui("a failed folder migration retains settings and current notes", { seed: seed({ "": { 页: "不能丢" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { migrationError: "目标文件夹不为空" }; });
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await p.fill("#set-dir", "D:\\Occupied");
    await p.click("#set-save");
    await until(() => p.textContent("#set-error"), "Error: 目标文件夹不为空");
    assert.equal(await p.evaluate(() => window.__minipad.state.settings.notes_dir), "");
    assert.equal(await h.mockFile("", "页"), "不能丢");
  });

  ui("rapid settings changes preserve independent fields", { seed: seed({ "": { 页: "文本" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => {
      window.__mockControl = { delay: { save_settings: 150 } };
      document.dispatchEvent(new CustomEvent("format-bar-items", { detail: { format_bar_hidden: ["undo"] } }));
      document.dispatchEvent(new CustomEvent("format-bar-items", { detail: { format_bar_order: ["strong", "undo"] } }));
    });
    await until(async () => {
      const s = (await h.stored())?.settings;
      return [s?.format_bar_hidden, s?.format_bar_order];
    }, [["undo"], ["strong", "undo"]], "both settings survive concurrent submissions");
  });

});

// ---------- 0.3.0:查找替换、冲突副本、从 minipad2 导入 ----------
const FIND_PAGE = { "": { 水果: "苹果 apple Apple 香蕉 apple\n\n第二段 apple_pie applesauce", 别的: "这页也有 apple" } };
const findCount = (p) => p.textContent("#find-count");
// 编辑区里高亮的匹配,当前这个后面加 *
const findHits = (p) => p.$$eval("#editor .find-hit", (els) => els.map((e) => e.textContent + (e.classList.contains("find-current") ? "*" : "")));

describe("0.3.0: find and replace", () => {
  ui("Ctrl+F finds in the page while typing; Enter, Shift+Enter and F3 step through; Esc closes it and leaves the match selected", { seed: seed(FIND_PAGE) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.press("Control+Home");
    await p.keyboard.press("Control+f");
    await p.locator("#find-bar").waitFor();
    assert.equal(await p.evaluate(() => document.activeElement.id), "find-input", "the find box gets the focus");
    assert.ok(await p.isHidden("#search"), "not the search over all pages");
    await p.keyboard.type("apple");
    await until(() => findCount(p), "1/5", "counts every match, not matching case");
    assert.deepEqual(await findHits(p), ["apple*", "Apple", "apple", "apple", "apple"], "all matches are highlighted, the current one darker");
    await p.keyboard.press("Enter");
    await until(() => findCount(p), "2/5", "Enter goes to the next");
    await p.keyboard.press("Shift+Enter");
    await p.keyboard.press("Shift+Enter");
    await until(() => findCount(p), "5/5", "Shift+Enter goes back, around the end");
    await p.keyboard.press("F3");
    await until(() => findCount(p), "1/5", "F3 goes on from the start");
    // 区分大小写、全字匹配
    await p.keyboard.press("Alt+c");
    await until(() => findCount(p), "1/4", "Alt+C matches case");
    assert.equal(await p.getAttribute('#find-bar [data-opt="caseSensitive"]', "aria-pressed"), "true");
    await p.keyboard.press("Alt+w");
    await until(() => findCount(p), "1/2", "Alt+W: whole words only, apple_pie and applesauce are not");
    await p.keyboard.press("Alt+c");
    await p.keyboard.press("Alt+w");
    await p.keyboard.type("x");
    await until(() => findCount(p), "无结果");
    assert.ok(await p.locator(".find-field.none").isVisible(), "the box turns red");
    assert.ok(await p.isDisabled("#find-next"), "nothing to go to");
    await p.keyboard.press("Backspace");
    await until(() => findCount(p), "1/5");
    await p.keyboard.press("Enter");
    await until(() => findCount(p), "2/5");
    await p.keyboard.press("Escape");
    await until(() => p.isHidden("#find-bar"), true, "Esc closes the find bar");
    assert.ok(await h.editorFocused(), "the cursor goes back to the editor");
    assert.equal(await h.selection(), "Apple", "with the last match selected");
    assert.equal(await p.locator("#editor .find-hit").count(), 0, "no highlights left");
    assert.equal(await h.toast(), "", "the window stays");
    await p.keyboard.press("Escape");
    await until(async () => (await h.toast()).includes("隐藏"), true, "the next Esc hides the window");
  });

  ui("Ctrl+H replaces one at a time or all at once (one undo step), also with regex groups", { seed: seed({ "": { 日程: "2024-01-05 会议\n2025-12-31 跨年" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.press("Control+Home");
    await p.keyboard.press("Control+h");
    await p.locator("#find-replace").waitFor();
    assert.equal(await p.getAttribute("#find-toggle", "aria-expanded"), "true");
    assert.equal(await p.evaluate(() => document.activeElement.id), "find-input", "nothing to find yet: the find box gets the focus");
    await p.keyboard.press("Alt+r");
    await p.keyboard.type("(\\d{4})-(\\d\\d)-(\\d\\d)");
    await until(() => findCount(p), "1/2", "a regular expression");
    await p.fill("#replace-input", "$3/$2/$1");
    await p.press("#replace-input", "Enter");
    await until(h.editor, "05/01/2024 会议\n2025-12-31 跨年", "Enter replaces the current match");
    await until(() => findCount(p), "1/1", "and goes to the next");
    await p.fill("#find-input", "会议|跨年");
    await until(() => findCount(p), "2/2");
    await p.fill("#replace-input", "[$&]");
    await p.press("#replace-input", "Control+Enter");
    await until(h.editor, "05/01/2024 \\[会议]\n2025-12-31 \\[跨年]", "Ctrl+Enter replaces them all");
    assert.equal(await h.toast(), "替换了 2 处(Ctrl+Z 可以撤销)");
    await until(() => h.mockFile("", "日程"), "05/01/2024 \\[会议]\n2025-12-31 \\[跨年]", "and it is saved");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Control+z");
    assert.equal(await h.editor(), "05/01/2024 会议\n2025-12-31 跨年", "one Ctrl+Z takes back the whole replace-all");
    await p.keyboard.press("Control+z");
    assert.equal(await h.editor(), "2024-01-05 会议\n2025-12-31 跨年", "the next one the single replace");
  });

  ui("a regex replacement understands $& $1 $<name> $$ and \\n \\t; a plain one is taken as it is", async (h) => {
    const out = await h.p.evaluate(async () => {
      const { expandReplacement } = await import("./js/find.js");
      const m = /(?<y>\d{4})-(\d\d)/.exec("x 2024-05 y");
      return [
        expandReplacement("$2/$1", m, true),
        expandReplacement("[$&]", m, true),
        expandReplacement("$<y>年", m, true),
        expandReplacement("$$1 $9 $<nope>", m, true),
        expandReplacement("$10", m, true),
        expandReplacement("a\\nb\\tc\\\\n", m, true),
        expandReplacement("$1\\n", m, false),
      ];
    });
    assert.deepEqual(out, ["05/2024", "[2024-05]", "2024年", "$1 $9 $<nope>", "20240", "a\nb\tc\\n", "$1\\n"]);
  });

  ui("the find bar stays open across pages: every page is searched, and typing updates the matches", { seed: seed(FIND_PAGE) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.press("Control+f");
    await p.keyboard.type("apple");
    await until(() => findCount(p), "1/5");
    await h.tab("别的").click();
    await until(() => findHits(p), ["apple"], "the other page is highlighted too");
    assert.equal(await findCount(p), "1 个", "no current match there yet");
    await p.keyboard.press("F3");
    await until(() => findCount(p), "1/1", "F3 goes to it");
    await p.keyboard.press("Control+End");
    await p.keyboard.type(" Apple");
    await until(async () => (await findHits(p)).length, 2, "a match typed in is found at once");
    assert.match(await findCount(p), /^(1\/2|2 个)$/);
    await h.tab("水果").click();
    await until(() => findCount(p), "1/5", "back on the first page");
  });

  ui("settings: Ctrl+F can search all pages instead, the find bar can sit below the editor, and its highlight color is chosen", { seed: seed({ "": { 页: "找一找 看看" } }) }, async (h) => {
    const { p } = h;
    assert.equal(await p.getAttribute("#btn-search", "title"), "搜索全部页面 (Ctrl+Shift+F)");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.inputValue("#set-ctrl-f"), "page");
    assert.equal(await p.inputValue("#set-find-pos"), "top");
    assert.ok(await p.locator('#set-find-color button.on[data-color=""]').isVisible(), "the highlight follows the accent color by default");
    await p.selectOption("#set-ctrl-f", "all");
    await p.selectOption("#set-find-pos", "bottom");
    await expandLibrary(p, "#set-find-color + .shared-colors");
    await p.click('#set-find-color + .shared-colors .uc-swatch[data-color="#3b82f6"]');
    assert.match(await p.$eval("#set-find-preview", (el) => el.style.getPropertyValue("--find-soft")), /#3b82f6 30%/, "the preview shows the color");
    await p.click("#set-save");
    await until(() => p.isHidden("#settings"), true);
    await until(
      async () => {
        const s = (await h.stored())?.settings;
        return [s?.ctrl_f, s?.find_bar_pos, s?.find_color];
      },
      ["all", "bottom", "#3b82f6"],
      "saved",
    );
    assert.equal(await p.getAttribute("#btn-search", "title"), "搜索全部页面 (Ctrl+F)");
    await p.click("#editor");
    await p.keyboard.press("Control+f");
    await p.locator("#search").waitFor();
    assert.ok(await p.isHidden("#find-bar"), "Ctrl+F now searches all pages");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Control+Shift+KeyF");
    await p.locator("#find-bar").waitFor();
    await p.keyboard.type("找");
    await until(() => findCount(p), "1/2");
    const top = (sel) => p.$eval(sel, (el) => el.getBoundingClientRect().top);
    assert.ok((await top("#find-bar")) > (await top("#editor")), "the bar sits below the editor");
    assert.ok((await top("#find-bar")) < (await top("#status")), "and above the status bar");
    assert.match(await p.$eval("html", (el) => el.style.getPropertyValue("--find-strong")), /#3b82f6 62%/, "the highlight uses the chosen color");
  });

  ui("the find button on the format bar opens the find bar with the selected text", { seed: seed({ "": { 页: "一段文字 文字" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+ArrowLeft");
    await p.keyboard.press("Shift+ArrowLeft");
    await until(h.selection, "文字");
    await p.click('#format-bar [data-cmd="find"]');
    await p.locator("#find-bar").waitFor();
    assert.equal(await p.inputValue("#find-input"), "文字", "the selection is what is looked for");
    assert.equal(await p.evaluate(() => document.activeElement.id), "find-input");
    await until(() => findCount(p), "2/2", "starting from the selection");
  });
});

describe("0.3.0: conflict copies", () => {
  const isCopy = (name) => /^周报 \(冲突 \d{4}-\d\d-\d\d \d\d\.\d\d\)$/.test(name);

  ui("a page changed both here and elsewhere keeps both: the other version becomes a conflict copy right after it", { seed: seed({ "": { 周报: "原来的", 别的: "x" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.press("Control+End");
    await p.keyboard.type("我改的");
    await until(() => h.mockFile("", "周报"), "原来的我改的", "saved");
    // 网盘把别处的修改同步过来了,这里还没读到就又打了字
    await p.evaluate(() => (window.__mockFiles["周报"] = "别处改的"));
    await p.keyboard.type("再改");
    await until(async () => (await h.tabs()).length, 3, "a conflict copy shows up");
    const tabs = await h.tabs();
    assert.equal(tabs[0], "周报");
    assert.ok(isCopy(tabs[1]), `named after the page and the time: ${tabs[1]}`);
    assert.equal(tabs[2], "别的", "the copy sits right after the page");
    assert.equal(await h.activeTab(), "周报", "the current page stays");
    assert.equal(await h.mockFile("", tabs[1]), "别处改的", "the copy holds the other version");
    assert.equal(await h.mockFile("", "周报"), "原来的我改的再改", "the page keeps what was typed here");
    assert.equal(await h.editor(), "原来的我改的再改");
    assert.match(await h.toast(), /^「周报」在别处也被修改了,别处的版本另存成了「周报 \(冲突 .+\)」$/);
    await until(async () => (await h.stored())?.books[""].meta.order, ["周报", tabs[1], "别的"], "the order is saved");
    await h.tab(tabs[1]).click();
    await until(h.editor, "别处改的", "the copy opens like any page");
  });

  ui("a sync that finds the page changed elsewhere while it is being edited here also keeps a copy", { seed: seed({ "": { 周报: "原来的" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor");
    await p.keyboard.press("Control+End");
    await p.keyboard.type("!");
    // 本地的修改 500 ms 后才保存,在那之前文件在别处改了,而且先被同步读到
    await p.evaluate(() => {
      window.__mockFiles["周报"] = "别处改的";
      return window.__minipad.sync();
    });
    assert.equal(await h.editor(), "原来的!", "the edit here stays");
    await until(async () => (await h.tabs()).length, 2, "a conflict copy shows up");
    const copy = (await h.tabs())[1];
    assert.ok(isCopy(copy), copy);
    assert.equal(await h.mockFile("", copy), "别处改的");
    await until(() => h.mockFile("", "周报"), "原来的!", "the edit here is saved");
  });

  ui("settings: conflict copies are on by default and can be switched to overwriting", { seed: seed({ "": { 周报: "原来的" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    assert.equal(await p.inputValue("#set-conflict"), "copy");
    await p.selectOption("#set-conflict", "overwrite");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.conflict_mode, "overwrite", "saved");
    await p.click("#editor");
    await p.keyboard.press("Control+End");
    await p.keyboard.type("!");
    await until(() => h.mockFile("", "周报"), "原来的!");
    await p.evaluate(() => (window.__mockFiles["周报"] = "别处改的"));
    await p.keyboard.type("?");
    await until(() => h.mockFile("", "周报"), "原来的!?", "the page is simply overwritten");
    assert.deepEqual(await h.tabs(), ["周报"], "no copy");
  });
});

// minipad2 导入时纯文字转成的 Markdown:和 src-tauri/src/minipad2.rs 测试里的 ESCAPES 是同一张表,改的时候两边一起改。
// 编辑器打开以后显示的必须正是原来的文字,改过再保存、重新打开也还是
const MINIPAD2_ESCAPES = [
  ["# 标题", "\\# 标题"],
  ["> 引用", "\\> 引用"],
  ["- 列表", "\\- 列表"],
  ["+ 加号", "\\+ 加号"],
  ["* 星号", "\\* 星号"],
  ["1. 第一", "1\\. 第一"],
  ["2) 第二", "2\\) 第二"],
  ["3.14 和 2020年", "3.14 和 2020年"],
  ["===", "\\==="],
  ["___", "\\_\\_\\_"],
  ["a*b*c", "a\\*b\\*c"],
  ["snake_case 和 _斜体_", "snake_case 和 \\_斜体\\_"],
  ["`代码` ~~删除~~", "\\`代码\\` \\~\\~删除\\~\\~"],
  ["[链接](x) ![图](y)", "\\[链接](x) !\\[图](y)"],
  ["<b>粗</b> <不是标签>", "\\<b>粗\\</b> \\<不是标签>"],
  ["a | b", "a \\| b"],
  ["&amp; & &#123;", "\\&amp; & \\&#123;"],
  ["C:\\temp\\", "C:\\temp\\\\"],
  ["\\_x", "\\\\\\_x"],
  ["    缩进四格", "&#x20;   缩进四格"],
  ["\t制表符", "&#x9;制表符"],
  ["　　全角空格", "　　全角空格"],
  ["看 https://a.com/x_y?q=1&r=2。好", "看 <https://a.com/x_y?q=1&r=2>。好"],
  ["www.a.com/b_c*d 和 www.。", "www.a.com/b_c*d 和 www.。"],
];

describe("email link recognition", () => {
  const MD = "写信给 name@example.com，访问 https://example.com\n\n[手动邮箱](mailto:contact@example.com)";

  ui("bare email stays plain; URL and explicit mailto links remain clickable", {
    seed: seed({ "": { 页: MD } }),
  }, async (h) => {
    const { p } = h;
    const links = p.locator("#editor .ProseMirror a");
    assert.equal(await links.count(), 2);
    assert.deepEqual(await links.evaluateAll((els) => els.map((el) => el.getAttribute("href"))),
      ["https://example.com", "mailto:contact@example.com"]);
    assert.ok(await p.locator("#editor .ProseMirror > p").first().textContent().then((text) =>
      text.includes("name@example.com")), "email remains visible as text");
    assert.ok(!(await h.editor()).includes("<name@example.com>"), "bare email is not serialized as a link");
    assert.equal(await h.mockFile("", "页"), MD, "opening the note does not rewrite it");
  });

  ui("typing and reopening an email keeps it as ordinary text", {
    seed: seed({ "": { 页: "联系：" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .ProseMirror > p").click();
    await p.keyboard.press("Control+End");
    await p.keyboard.type("name@example.com");
    await p.keyboard.press("Space");
    assert.equal(await p.locator("#editor .ProseMirror a").count(), 0);
    const markdown = await h.editor();
    assert.ok(markdown.includes("name@example.com"), JSON.stringify({markdown,
      text: await p.locator("#editor .ProseMirror").textContent()}));
    await until(async () => (await h.mockFile("", "页")).includes("name@example.com"), true);
    await p.reload();
    assert.equal(await p.locator("#editor .ProseMirror a").count(), 0,
      "a saved bare email stays plain after reloading");
  });

  ui("the email link setting toggles recognition without rewriting the note", {
    seed: seed({ "": { 页: MD } }),
  }, async (h) => {
    const { p } = h;
    const links = p.locator("#editor .ProseMirror a");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.isChecked("#set-email-links"), false);
    await p.check("#set-email-links");
    await p.click("#set-save");
    await until(async () => links.count(), 3, "turning on recognition updates current note");
    assert.equal(await h.mockFile("", "页"), MD, "changing settings does not rewrite notes");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    await p.uncheck("#set-email-links");
    await p.click("#set-save");
    await until(async () => links.count(), 2, "turning it back off preserves explicit mailto links");
    assert.equal(await h.mockFile("", "页"), MD);
  });
});

describe("0.3.0: import from minipad2", () => {
  const MP2 = {
    pickFolder: "D:\\Tools\\minipad2",
    minipad2: {
      path: "D:\\Tools\\minipad2",
      preview: { version: "3.2.1", groups: 2, pages: 9, empty: 1, lists: 3, clips: 12, recycled: 0, highlights: true, warnings: ["第 12 行看不懂,跳过了"] },
      books: [
        { name: "旧笔记", pages: [["随手记", "第一行"]] },
        { name: "工作", pages: [["周报", "本周"], ["计划", "下周"]] },
      ],
      skipped: 1,
    },
  };

  ui("import from the notebooks menu: pick the folder, see what is in it, choose, and land in the new notebook", { seed: seed({ "": { 首页: "hello" }, 工作: { 旧的: "保留" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate((c) => (window.__mockControl = c), MP2);
    await h.openBooks();
    await p.click("#books-import");
    await p.locator("#import-found").waitFor();
    assert.equal(await p.inputValue("#import-path"), "D:\\Tools\\minipad2", "the picked folder");
    assert.equal(await p.textContent("#import-summary"), "找到了 minipad2 3.2.1 的数据:2 个分组、9 个笔记页面。");
    assert.ok(await p.isHidden("#import-recycle-row"), "nothing in the recycle bin, so no option for it");
    assert.equal(await p.textContent("#import-clips-text"), "剪贴文字(12 条),放进一页");
    assert.ok(!(await p.isChecked("#import-clips")), "clips are off by default");
    assert.ok(await p.isChecked("#import-skip-empty"), "empty pages are skipped by default");
    assert.deepEqual(await p.$$eval("#import-warnings li", (els) => els.map((e) => e.textContent)), ["第 12 行看不懂,跳过了"]);
    assert.equal(await p.textContent("#import-base-label"), "分组外的页面放进");
    await p.selectOption("#import-layout", "single");
    assert.equal(await p.textContent("#import-base-label"), "导入到笔记本");
    await p.fill("#import-base", "旧笔记");
    await p.check("#import-clips");
    await p.uncheck("#import-highlights");
    assert.equal(await p.textContent("#import-ok"), "预览");
    await p.click("#import-ok");
    // 先进暂存区:列出会建的笔记本和页面,还没写进去
    await p.locator("#import-stage").waitFor();
    assert.ok(await p.isHidden("#import-setup"));
    assert.deepEqual(await p.$$eval("#import-stage .st-book > summary .st-name", (els) => els.map((e) => e.textContent)), ["旧笔记", "工作"]);
    assert.deepEqual(await p.$$eval("#import-stage .st-page-row .st-name", (els) => els.map((e) => e.textContent)), ["随手记", "周报", "计划"]);
    assert.match(await p.textContent("#import-stage-summary"), /会新建 2 个笔记本、3 页/);
    assert.equal(await p.textContent("#import-ok"), "导入 3 页");
    assert.deepEqual(await p.evaluate(() => Object.keys(window.__mockBooks).sort()), ["", "工作"], "nothing is written while staged");
    await p.click("#import-ok");
    await p.locator("#import-result").waitFor();
    assert.deepEqual(
      await p.evaluate(() => window.__mockControl.minipad2.options),
      { layout: "single", base: "旧笔记", skip_empty: true, lists: true, clips: true, recycle: false, highlights: false },
      "the choices go to the import",
    );
    assert.equal(await p.textContent("#import-result p >> nth=0"), "导入了 3 页,新建了 2 个笔记本:「旧笔记」、「工作 (2)」。");
    assert.equal(await p.textContent("#import-result p >> nth=2"), "跳过了 1 个空白的页面。");
    await until(h.bookName, "旧笔记", "the first new notebook opens");
    assert.deepEqual(await h.tabs(), ["随手记"]);
    assert.equal(await p.textContent("#import-ok"), "完成");
    await p.click("#import-ok");
    await until(() => p.isHidden("#import"), true);
    const books = await h.listBooks();
    assert.deepEqual(books.map((b) => [b.name, b.count]), [["默认", 1], ["工作", 1], ["工作 (2)", 2], ["旧笔记", 1]], "new notebooks next to the old ones");
    assert.equal(await h.mockFile("工作", "旧的"), "保留", "existing notes are untouched");
  });

  ui("0.3.10: unticked notebooks and pages in the staging area are left out; back returns to the options", { seed: seed({ "": { 首页: "hello" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate((c) => (window.__mockControl = c), MP2);
    await h.openBooks();
    await p.click("#books-import");
    await p.locator("#import-found").waitFor();
    await p.click("#import-ok");
    await p.locator("#import-stage").waitFor();
    // 上一步回到选项,改了再预览
    await p.click("#import-back");
    assert.ok(await p.isVisible("#import-setup"));
    assert.ok(await p.isHidden("#import-stage"));
    assert.equal(await p.textContent("#import-ok"), "预览");
    await p.click("#import-ok");
    await p.locator("#import-stage").waitFor();
    // 整个「旧笔记」不要,「工作」里不要「计划」
    await p.locator(".st-book >> nth=0").locator("summary input").uncheck();
    await p.locator(".st-book >> nth=1").evaluate((d) => (d.open = true));
    await p.locator('.st-page-row:has-text("计划") input').uncheck();
    assert.ok(await p.locator(".st-book >> nth=1").locator("summary input").evaluate((c) => c.indeterminate), "partly ticked notebook");
    assert.equal(await p.textContent("#import-ok"), "导入 1 页");
    assert.match(await p.textContent("#import-stage-summary"), /会新建 1 个笔记本、1 页/);
    // 全都不勾就不能导入
    await p.locator('.st-page-row:has-text("周报") input').uncheck();
    assert.ok(await p.isDisabled("#import-ok"));
    assert.ok(!(await p.locator(".st-book >> nth=1").locator("summary input").isChecked()));
    await p.locator('.st-page-row:has-text("周报") input').check();
    await p.click("#import-ok");
    await p.locator("#import-result").waitFor();
    assert.deepEqual(await p.evaluate(() => window.__mockControl.minipad2.leave), { books: [0], pages: [[1, 1]] });
    assert.equal(await p.textContent("#import-result p >> nth=0"), "导入了 1 页,新建了 1 个笔记本:「工作」。");
    assert.deepEqual(await h.tabs(), ["周报"]);
  });

  ui("import from the settings: a folder without minipad2 data says so; Esc closes only the import window", { seed: seed({ "": { 首页: "hello" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate((c) => (window.__mockControl = { ...c, pickFolder: "D:\\Downloads" }), MP2);
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await p.click("#set-import");
    await until(
      () => p.textContent("#import-error"),
      "「D:\\Downloads」里没有找到 minipad2 的数据。请选 minipad2 的程序文件夹(里面有 data 文件夹),或者它的 data 文件夹",
      "the folder has no data",
    );
    assert.ok(await p.isDisabled("#import-ok"), "nothing to import");
    await p.fill("#import-path", "D:\\Tools\\minipad2");
    await p.press("#import-path", "Enter");
    await p.locator("#import-found").waitFor();
    assert.ok(await p.isHidden("#import-error"));
    assert.ok(await p.isEnabled("#import-ok"));
    await p.keyboard.press("Escape");
    await until(() => p.isHidden("#import"), true, "Esc closes the import window");
    assert.ok(await p.isVisible("#settings"), "the settings stay open underneath");
    assert.equal(await p.evaluate(() => document.activeElement.id), "set-import");
    await p.keyboard.press("Escape");
    await until(() => p.isHidden("#settings"), true);
  });

  ui("text imported from minipad2 shows exactly as it was written there, also after the editor saves it again", { seed: seed({ "": { 页: "" } }) }, async (h) => {
    const { p } = h;
    const text = () => p.evaluate(() => window.__minipad.editor().text());
    const open = (md) => p.evaluate((m) => (window.__mockFiles["页"] = m), md);
    for (const [plain, md] of MINIPAD2_ESCAPES) {
      await open(md);
      await syncUntil(h, text, plain, `${JSON.stringify(md)} shows as ${JSON.stringify(plain)}`);
      // 编辑器保存时有自己的写法(比如多转义一个括号、网址写成链接),重新打开还是原来的文字
      const saved = await h.editor();
      await open(saved);
      await syncUntil(h, text, plain, `and so does ${JSON.stringify(saved)}, as the editor saves it`);
    }
  });
});

// ---------- 0.3.1:设置分类 ----------
describe("0.3.2: settings in five categories", () => {
  const shown = (p) => p.$$eval(".set-page", (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.page));
  const focused = (p) => p.evaluate(() => document.activeElement?.dataset?.page ?? null);
  const navDirection = (p) => p.$eval("#set-nav", (n) => getComputedStyle(n).flexDirection);

  ui("settings: only the chosen category shows, arrow keys move between them, and the settings reopen where they were left", async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    assert.deepEqual(
      await p.$$eval("#set-nav [role=tab]", (els) => els.map((e) => e.textContent.trim())),
      ["常规", "外观", "窗口", "编辑", "数据"],
    );
    assert.deepEqual(await shown(p), ["general"], "常规 comes first");
    assert.deepEqual(await p.$$eval('#set-nav [aria-selected="true"]', (els) => els.map((e) => e.dataset.page)), ["general"]);
    assert.equal(await focused(p), "general", "the focus is on the category");
    assert.ok(await p.isVisible("#set-hotkey"));
    assert.ok(await p.isHidden("#set-theme"), "other categories are hidden");

    await settingsPage(p, "edit");
    assert.deepEqual(await shown(p), ["edit"]);
    assert.ok(await p.isVisible("#set-ctrl-f"), "编辑 holds the editor, outline and find settings");
    assert.ok(await p.isVisible("#set-outline"));
    assert.ok(await p.isVisible("#set-code-lines"));
    assert.ok(await p.isHidden("#set-hotkey"));
    assert.deepEqual(
      await p.$$eval('.set-page[data-page="edit"] h3', (els) => els.map((e) => e.textContent)),
      ["编辑器", "链接", "块管理", "悬浮工具栏", "悬浮目录", "查找替换"],
      "with a small heading for each part",
    );
    await p.keyboard.press("ArrowDown");
    assert.deepEqual(await shown(p), ["data"], "↓ goes to the next category");
    assert.equal(await focused(p), "data");
    await p.keyboard.press("ArrowUp");
    await p.keyboard.press("ArrowUp");
    assert.deepEqual(await shown(p), ["window"], "↑ goes back");
    await p.keyboard.press("End");
    assert.deepEqual(await shown(p), ["data"]);
    await p.keyboard.press("ArrowDown");
    assert.deepEqual(await shown(p), ["general"], "and wraps around");
    await p.keyboard.press("End");
    await p.keyboard.press("Home");
    assert.deepEqual(await shown(p), ["general"]);

    // 内容再多,保存和取消也一直在窗口里
    await settingsPage(p, "window");
    const box = await p.locator("#set-save").boundingBox();
    assert.ok(box && box.y + box.height <= 540, `save stays in view: ${JSON.stringify(box)}`);

    await settingsPage(p, "look");
    await p.click("#set-cancel");
    await p.click("#btn-settings");
    assert.deepEqual(await shown(p), ["look"], "reopens on the category seen last");

    // 换了分类,前面改的也一起保存
    await p.selectOption("#set-theme", "dark");
    await settingsPage(p, "edit");
    await p.uncheck("#set-code-lines");
    await p.click("#set-save");
    await until(
      async () => {
        const s = (await h.stored())?.settings;
        return [s?.theme, s?.code_line_numbers];
      },
      ["dark", false],
      "changes from both categories are saved",
    );
    await p.reload();
    await p.waitForSelector("#tabs .tab");
    await p.click("#btn-settings");
    assert.deepEqual(await shown(p), ["edit"], "still remembered after a restart");
  });

  ui("settings: the categories can sit on top instead of on the left, and a narrow window puts them on top", async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    assert.equal(await navDirection(p), "column", "on the left by default");
    await p.setViewportSize({ width: 320, height: 540 });
    assert.equal(await navDirection(p), "row", "a narrow window puts them on top");
    await p.setViewportSize({ width: 440, height: 540 });
    assert.equal(await navDirection(p), "column");

    await settingsPage(p, "look");
    assert.equal(await p.inputValue("#set-nav-pos"), "left");
    await p.selectOption("#set-nav-pos", "top");
    assert.equal(await navDirection(p), "row", "moves on top right away");
    await p.click("#set-cancel");
    await p.click("#btn-settings");
    assert.equal(await navDirection(p), "column", "cancel puts it back");
    assert.equal(await p.inputValue("#set-nav-pos"), "left");

    await p.selectOption("#set-nav-pos", "top");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.settings_nav, "top", "saved");
    await p.click("#btn-settings");
    assert.equal(await navDirection(p), "row");
    assert.equal(await p.inputValue("#set-nav-pos"), "top");
    assert.equal(await focused(p), "look");
    await p.keyboard.press("ArrowRight");
    assert.deepEqual(await shown(p), ["window"], "→ goes to the next category when they are on top");
    await p.keyboard.press("ArrowLeft");
    assert.deepEqual(await shown(p), ["look"]);
    await p.click("#set-cancel");
  });

  ui("settings: an error when saving shows below and switches to the category it is about", { seed: seed({ "": { 页: "不能丢" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => {
      window.__mockControl = { migrationError: "目标文件夹不为空" };
    });
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await p.fill("#set-dir", "D:\\Occupied");
    await settingsPage(p, "general");
    await p.click("#set-save");
    await until(() => p.textContent("#set-error"), "Error: 目标文件夹不为空");
    assert.ok(await p.isVisible("#set-error"));
    assert.deepEqual(await shown(p), ["data"], "shows the notes folder setting");
    assert.ok(await p.isVisible("#settings"), "the settings stay open");
    assert.equal(await p.evaluate(() => window.__minipad.state.settings.notes_dir), "");
  });

  ui("settings: a category remembered from 0.3.1 opens the category it was merged into", async (h) => {
    const { p } = h;
    await p.evaluate(() => localStorage.setItem("minipad-next-settings-page", "backup"));
    await p.reload();
    await p.waitForSelector("#tabs .tab");
    await p.click("#btn-settings");
    assert.deepEqual(await shown(p), ["data"]);
    assert.ok(await p.isVisible("#set-backup"));
    await p.click("#set-cancel");
  });
});

// ---------- 0.3.1:悬浮目录 ----------
describe("0.3.1: floating outline", () => {
  const TEXT = "一段正文,撑开页面的高度。".repeat(12);
  const PLAN = ["# 项目计划", TEXT, "## 背景", TEXT, "## 目标", TEXT, "### 第一阶段", TEXT, "#### 细节", TEXT, "## 做法", TEXT, "# 附录", TEXT].join("\n\n");
  const ON = { ...SETTINGS, outline_enabled: true };
  const items = (p) => p.$$eval("#outline .ol-item", (els) => els.map((e) => e.textContent));
  const current = (p) => p.$$eval("#outline .ol-item.on", (els) => els.map((e) => e.textContent));
  const strip = (p) => p.$$eval("#outline .ol-strip i", (els) => els.map((e) => (e.classList.contains("on") ? "on" : "")));
  const panelShown = (p) => p.$eval("#outline .ol-panel", (e) => getComputedStyle(e).visibility === "visible" && getComputedStyle(e).opacity === "1");
  const mainAttr = (p) => p.$eval("#main", (m) => [m.dataset.outline, m.dataset.olSide]);
  const scrollTop = (p) => p.$eval("#editor", (e) => e.scrollTop);

  ui("outline: off by default; turned on in the settings it lists the headings up to the chosen level, and opens when the mouse is on its lines", { seed: seed({ "": { 计划: PLAN } }) }, async (h) => {
    const { p } = h;
    assert.ok(await p.isHidden("#outline"), "off by default");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.isChecked("#set-outline"), false);
    assert.ok(await p.isDisabled("#set-outline-mode"), "the options are off while the outline is off");
    await p.check("#set-outline");
    assert.ok(await p.isEnabled("#set-outline-mode"));
    assert.equal(await p.inputValue("#set-outline-mode"), "hover");
    assert.equal(await p.inputValue("#set-outline-side"), "right");
    assert.equal(await p.inputValue("#set-outline-depth"), "3");
    assert.equal(await p.textContent("#set-outline-width-val"), "200 像素");
    assert.equal(await p.getAttribute("#set-outline-color button.on", "title"), "跟随强调色");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.outline_enabled, true, "saved");

    await until(() => items(p), ["项目计划", "背景", "目标", "第一阶段", "做法", "附录"], "headings up to level 3");
    assert.deepEqual(await mainAttr(p), ["hover", "right"]);
    assert.equal((await strip(p)).length, 6, "one line per heading");
    assert.equal(await panelShown(p), false, "folded into lines");
    await p.hover("#outline .ol-strip");
    await until(() => panelShown(p), true, "opens on hover");
    await p.mouse.move(20, 300);
    await until(() => panelShown(p), false, "folds again when the mouse leaves");

    await p.click("#btn-settings");
    await p.selectOption("#set-outline-depth", "1");
    await p.click("#set-save");
    await until(() => items(p), ["项目计划", "附录"], "only level 1");
    await p.click("#btn-settings");
    await p.selectOption("#set-outline-depth", "4");
    await p.click("#set-save");
    await until(() => items(p), ["项目计划", "背景", "目标", "第一阶段", "细节", "做法", "附录"], "down to level 4");
  });

  ui("outline: clicking a heading scrolls to it and puts the cursor there; the section being read lights up while scrolling", { seed: { ...seed({ "": { 计划: PLAN } }), settings: ON } }, async (h) => {
    const { p } = h;
    await until(() => items(p), ["项目计划", "背景", "目标", "第一阶段", "做法", "附录"], "listed");
    assert.deepEqual(await current(p), ["项目计划"], "the first heading is at the top");
    await p.hover("#outline .ol-strip");
    await until(() => panelShown(p), true, "open");
    await p.locator("#outline .ol-item", { hasText: "做法" }).click();
    const headingTop = () => p.evaluate(() => {
      const el = [...document.querySelectorAll("#editor h2")].find((e) => e.textContent === "做法");
      return Math.round(el.getBoundingClientRect().top - document.querySelector("#editor").getBoundingClientRect().top);
    });
    await until(async () => Math.abs((await headingTop()) - 8) <= 2, true, "scrolled so the heading is at the top");
    assert.equal(await p.evaluate(() => window.__minipad.editor().view.state.selection.$from.parent.textContent), "做法", "the cursor is in the heading");
    assert.ok(await h.editorFocused(), "and the editor has the focus");
    await until(() => current(p), ["做法"], "the heading lights up");
    assert.deepEqual(await strip(p), ["", "", "", "", "on", ""], "so does its line");

    // 点击后的平滑滚动要等 scrollend(没收到时最多一秒)记下落点;落点还没记下就手动滚回顶部,会被当成还停在原处
    await sleep(1100);
    await p.$eval("#editor", (e) => (e.scrollTop = 0));
    await until(() => current(p), ["项目计划"], "back at the top");
    await p.$eval("#editor", (e) => {
      const el = [...e.querySelectorAll("h2")].find((x) => x.textContent === "目标");
      e.scrollTop += el.getBoundingClientRect().top - e.getBoundingClientRect().top + 60;
    });
    await until(() => current(p), ["目标"], "reading the section under 目标");
    await p.$eval("#editor", (e) => (e.scrollTop = e.scrollHeight));
    await until(() => current(p), ["附录"], "at the end the last heading lights up");
    assert.ok((await scrollTop(p)) > 0);
  });

  ui("outline: it can stay open on the left; a window too narrow folds it into lines, and pages without headings show none", { seed: { ...seed({ "": { 计划: PLAN, 空白: "没有标题的一页" } }), settings: { ...ON, outline_mode: "pinned", outline_side: "left" } } }, async (h) => {
    const { p } = h;
    await until(() => mainAttr(p), ["pinned", "left"], "open on the left");
    assert.equal(await panelShown(p), true, "open without the mouse");
    const editorLeft = () => p.$eval("#editor", (e) => Math.round(e.getBoundingClientRect().left - e.parentElement.getBoundingClientRect().left));
    assert.equal(await editorLeft(), 200, "the text moves over to make room");
    await p.setViewportSize({ width: 380, height: 540 });
    await until(() => mainAttr(p), ["hover", "left"], "too narrow: folded into lines");
    assert.equal(await editorLeft(), 0);
    await until(() => panelShown(p), false, "and stays folded until the mouse comes");
    await p.setViewportSize({ width: 440, height: 540 });
    await until(() => mainAttr(p), ["pinned", "left"], "open again");

    await h.tab("空白").click();
    await until(() => p.isVisible("#outline .ol-empty"), true, "open: says the page has no headings");
    assert.deepEqual(await items(p), []);
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    await p.selectOption("#set-outline-mode", "hover");
    await p.click("#set-save");
    await until(() => p.isHidden("#outline"), true, "folded: nothing shows on a page without headings");
    await h.tab("计划").click();
    await until(() => p.isVisible("#outline"), true);
    assert.equal((await items(p)).length, 6);
  });

  ui("outline: it follows the headings as they are typed and changes with the page", { seed: { ...seed({ "": { 甲: "# 第一页\n\n正文", 乙: "## 第二页的标题" } }), settings: ON } }, async (h) => {
    const { p } = h;
    await until(() => items(p), ["第一页"], "the first page");
    await p.click("#editor .ProseMirror p");
    await p.keyboard.press("End");
    await p.keyboard.press("Enter");
    await p.keyboard.type("## 新加的一节");
    await until(() => items(p), ["第一页", "新加的一节"], "a heading being typed shows up");
    await h.tab("乙").click();
    await until(() => items(p), ["第二页的标题"], "page switched");
    await h.tab("甲").click();
    await until(() => items(p), ["第一页", "新加的一节"], "and back");
  });

  ui("outline: position, width, background and color are saved and shown in the preview", { seed: { ...seed({ "": { 计划: PLAN } }), settings: ON } }, async (h) => {
    const { p } = h;
    const vars = (sel) => p.$eval(sel, (e) => ["--ol-width", "--ol-alpha", "--ol-c"].map((v) => e.style.getPropertyValue(v)));
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.deepEqual(await vars("#set-outline-preview"), ["200px", "100%", ""], "the preview starts with the saved look");
    await p.$eval("#set-outline-width", (e) => {
      e.value = "260";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await p.$eval("#set-outline-opacity", (e) => {
      e.value = "70";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expandLibrary(p, "#set-outline-color + .shared-colors");
    await p.click('#set-outline-color + .shared-colors .uc-swatch[data-color="#3b82f6"]');
    assert.equal(await p.textContent("#set-outline-width-val"), "260 像素");
    assert.equal(await p.textContent("#set-outline-opacity-val"), "70%");
    assert.deepEqual(await vars("#set-outline-preview"), ["260px", "70%", "#3b82f6"], "the preview follows right away");
    assert.deepEqual(await vars("#main"), ["200px", "100%", ""], "the outline itself changes only when saved");
    await p.selectOption("#set-outline-side", "left");
    await p.click("#set-save");
    await until(
      async () => {
        const s = (await h.stored())?.settings;
        return [s?.outline_width, s?.outline_opacity, s?.outline_color, s?.outline_side];
      },
      [260, 70, "#3b82f6", "left"],
      "saved",
    );
    assert.deepEqual(await vars("#main"), ["260px", "70%", "#3b82f6"]);
    assert.deepEqual(await mainAttr(p), ["hover", "left"]);
    await p.hover("#outline .ol-strip");
    await until(() => panelShown(p), true);
    assert.equal(await p.$eval("#outline .ol-panel", (e) => Math.round(e.getBoundingClientRect().width)), 260);
    assert.equal(await p.$eval("#outline .ol-item.on", (e) => getComputedStyle(e).color), "rgb(59, 130, 246)", "the current heading in the chosen color");
  });
});

describe("0.3.2: when the tabs don't fit", () => {
  const PAGES = ["Memo", "Prompt", "Temp", "Chrome", "Account", "读书笔记", "待办", "一个名字特别长特别长的页面"];
  const many = (settings = {}) => {
    const db = seed({ "": Object.fromEntries(PAGES.map((n) => [n, `# ${n}`])) });
    Object.assign(db.settings, settings);
    return db;
  };
  const activeName = (p) => p.evaluate(() => window.__minipad.state.books[0].notes[window.__minipad.state.books[0].active].name);
  const truncated = (p) =>
    p.$$eval("#tabs .tab span", (els) => els.filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent));

  ui("tabs: one row that scrolls, names in full, the hidden end fades out, and the list button opens every page", { seed: many() }, async (h) => {
    const { p } = h;
    assert.deepEqual(await truncated(p), [], "no tab name is cut short");
    assert.equal(await p.$eval("#tabs", (t) => t.scrollWidth > t.clientWidth), true, "the tabs don't fit in 440px");
    assert.deepEqual(await p.$eval("#tabs", (t) => [t.classList.contains("fade-l"), t.classList.contains("fade-r")]), [false, true]);
    await p.$eval("#tabs", (t) => (t.scrollLeft = 60));
    await until(() => p.$eval("#tabs", (t) => t.classList.contains("fade-l")), true, "the start fades once scrolled");

    assert.ok(await p.isVisible("#btn-all"));
    assert.equal(await p.textContent("#all-count"), String(PAGES.length));
    await p.click("#btn-all");
    assert.ok(await p.isVisible("#pages-menu"));
    assert.deepEqual(await p.$$eval("#pm-list button", (els) => els.map((e) => e.textContent)), PAGES);
    assert.equal(await p.evaluate(() => document.activeElement.id), "pm-filter");
    await p.keyboard.type("长");
    assert.deepEqual(await p.$$eval("#pm-list button", (els) => els.map((e) => e.textContent)), ["一个名字特别长特别长的页面"]);
    await p.keyboard.press("Enter");
    assert.ok(await p.isHidden("#pages-menu"));
    assert.equal(await activeName(p), "一个名字特别长特别长的页面");
    // 这个标签比 440 像素窗口里的标签栏还宽:露出开头,剩下的滚过去看
    const box = await p.locator("#tabs .tab.active").boundingBox();
    const bar = await p.locator("#tabs").boundingBox();
    assert.ok(Math.abs(box.x - bar.x) <= 1, `the chosen tab is scrolled into view: ${box.x} vs ${bar.x}`);
    await p.click("#btn-all");
    await p.click('#pm-list button:has-text("Temp")');
    const temp = await p.locator("#tabs .tab.active").boundingBox();
    const bar2 = await p.locator("#tabs").boundingBox();
    assert.ok(temp.x >= bar2.x - 1 && temp.x + temp.width <= bar2.x + bar2.width + 1, "a shorter one is shown whole");

    await p.click("#btn-all");
    await p.keyboard.press("Escape");
    assert.ok(await p.isHidden("#pages-menu"), "Esc closes the list");
    assert.ok(await p.isVisible("#bar"), "and only the list");
  });

  ui("tabs: the fade and the list button can be turned off", { seed: many({ tab_fade: false, tab_list_button: false }) }, async (h) => {
    const { p } = h;
    assert.ok(await p.isHidden("#btn-all"));
    assert.deepEqual(await p.$eval("#tabs", (t) => t.className), "");
  });

  ui("tabs: in rows, the button spreads every tab out below the bar and picking one folds them back", { seed: many({ tab_overflow: "wrap" }) }, async (h) => {
    const { p } = h;
    assert.ok(await p.isVisible("#btn-all"));
    await p.click("#btn-all");
    assert.equal(await p.getAttribute("#bar", "data-expanded"), "true");
    assert.equal(await p.getAttribute("#btn-all", "aria-expanded"), "true");
    const boxes = await p.$$eval("#tabs .tab", (els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.left, r.right, r.top]));
    assert.ok(boxes.every(([l, r]) => l >= 0 && r <= 440), `every tab is in the window: ${JSON.stringify(boxes)}`);
    assert.ok(new Set(boxes.map((b) => Math.round(b[2]))).size > 1, "in more than one row");
    assert.deepEqual(await truncated(p), []);
    await p.click("#tabs .tab:nth-child(7)");
    assert.equal(await activeName(p), "待办");
    assert.equal(await p.getAttribute("#bar", "data-expanded"), null, "folds back after picking a page");

    await p.click("#btn-all");
    await p.keyboard.press("Escape");
    assert.equal(await p.getAttribute("#bar", "data-expanded"), null, "Esc folds them");
    await p.click("#btn-all");
    await p.mouse.click(200, 400);
    assert.equal(await p.getAttribute("#bar", "data-expanded"), null, "so does a click elsewhere");
  });

  ui("tabs: in the side list, the bar shows the page name and the list slides out, filters, and can be pinned", { seed: many({ tab_overflow: "drawer" }) }, async (h) => {
    const { p } = h;
    assert.ok(await p.isVisible("#btn-pages"));
    assert.equal(await p.textContent("#cur-page"), "Memo");
    assert.ok(await p.isHidden("#btn-all"));
    assert.equal(await p.$eval("#tabs", (t) => t.parentElement.id), "dr-list", "the tabs live in the list");
    assert.equal(await p.$eval("#drawer", (d) => getComputedStyle(d).visibility), "hidden");

    await p.click("#btn-pages");
    await until(() => p.$eval("#drawer", (d) => d.getBoundingClientRect().left), 0, "slides out from the left");
    assert.deepEqual(await truncated(p), []);
    await p.fill("#dr-filter", "Chr");
    assert.deepEqual(await p.$$eval("#tabs .tab:not(.filtered)", (els) => els.map((e) => e.textContent)), ["Chrome"]);
    await p.click("#tabs .tab:not(.filtered)");
    assert.equal(await activeName(p), "Chrome");
    assert.equal(await p.textContent("#cur-page"), "Chrome");
    await until(() => p.$eval("#drawer", (d) => d.classList.contains("open")), false, "closes after picking a page");
    assert.equal(await p.inputValue("#dr-filter"), "", "and clears the filter");

    await p.click("#btn-pages");
    await p.click("#dr-pin");
    await until(async () => (await h.stored())?.settings?.tab_drawer_pinned, true, "pinning is saved");
    assert.equal(await p.evaluate(() => document.documentElement.dataset.drawer), "pinned");
    assert.equal(await p.$eval("#main", (m) => getComputedStyle(m).marginLeft), "200px", "the editor moves aside");
    await p.click("#tabs .tab:nth-child(2)");
    assert.equal(await activeName(p), "Prompt");
    assert.equal(await p.evaluate(() => document.documentElement.dataset.drawer), "pinned", "stays open when pinned");
    await p.setViewportSize({ width: 400, height: 540 });
    await until(() => p.evaluate(() => document.documentElement.dataset.drawer), "closed", "too narrow: slides away again");
    assert.equal(await p.$eval("#main", (m) => getComputedStyle(m).marginLeft), "0px");
  });

  ui("tabs: the side list can come from the right and open when the mouse reaches that edge", { seed: many({ tab_overflow: "drawer", tab_drawer_side: "right", tab_drawer_hover: true, tab_drawer_width: 240 }) }, async (h) => {
    const { p } = h;
    await p.mouse.move(437, 300);
    await until(() => p.$eval("#drawer", (d) => Math.round(d.getBoundingClientRect().left)), 440 - 240, "slides out from the right edge");
    await p.mouse.move(300, 300);
    await p.mouse.move(100, 300);
    await until(() => p.$eval("#drawer", (d) => d.classList.contains("open")), false, "and back when the mouse leaves");
  });

  ui("tabs: the settings show the options of the chosen way, with a preview, and save them", async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.equal(await p.inputValue("#set-tab-overflow"), "scroll");
    assert.ok(await p.isVisible("#set-tab-fade"));
    assert.ok(await p.isHidden("#set-tab-rows"));
    assert.equal(await p.getAttribute("#set-tabs-preview", "data-mode"), "scroll");
    await p.selectOption("#set-tab-overflow", "wrap");
    assert.ok(await p.isVisible("#set-tab-rows"));
    assert.ok(await p.isHidden("#set-tab-fade"));
    assert.equal(await p.getAttribute("#set-tabs-preview", "data-mode"), "wrap");
    await p.selectOption("#set-tab-overflow", "drawer");
    assert.ok(await p.isVisible("#set-drawer-side"));
    await p.selectOption("#set-drawer-side", "right");
    await p.$eval("#set-drawer-width", (el) => {
      el.value = "260";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await p.textContent("#set-drawer-width-val"), "260 像素");
    await p.click("#set-save");
    await until(
      async () => {
        const s = (await h.stored())?.settings;
        return [s?.tab_overflow, s?.tab_drawer_side, s?.tab_drawer_width];
      },
      ["drawer", "right", 260],
      "saved",
    );
    assert.ok(await p.isVisible("#btn-pages"), "applied right away");
  });
});

describe("0.3.2: tab groups", () => {
  const PAGES = ["a", "b", "c", "d", "e"];
  const books = (settings = {}, meta = null) => {
    const db = seed({ "": Object.fromEntries(PAGES.map((n) => [n, n])) });
    Object.assign(db.settings, settings);
    if (meta) Object.assign(db.books[""].meta, meta);
    return db;
  };
  const strip = (p) =>
    p.$$eval("#tabs > *", (els) =>
      els.map((e) => (e.classList.contains("tab-group") ? `[${e.textContent}]` : e.classList.contains("folded") ? `(${e.textContent})` : e.textContent)),
    );
  const menu = (p) => p.$$eval("#ctx button", (els) => els.map((e) => e.textContent));
  const stored = async (h) => {
    const m = (await h.stored())?.books?.[""]?.meta;
    return { order: m?.order, groups: (m?.groups || []).map((g) => [g.name, g.color, g.collapsed]), note_groups: m?.note_groups };
  };

  ui("groups: off by default, so the tab menu has no group items", { seed: books() }, async (h) => {
    const { p } = h;
    await p.click("#tabs .tab:nth-child(2)", { button: "right" });
    assert.deepEqual(await menu(p), ["重命名", "固定标签", "移到笔记本…", "在小窗中打开", "删除页面"]);
  });

  ui("groups: a tab goes into a new group, which gets a name and colour, folds, and is saved with the notebook", { seed: books({ tab_groups: true }) }, async (h) => {
    const { p } = h;
    await p.click("#tabs .tab:nth-child(2)", { button: "right" });
    assert.deepEqual(await menu(p), ["重命名", "固定标签", "移到笔记本…", "添加到新分组", "在小窗中打开", "删除页面"]);
    await p.click('#ctx button[data-act="group-new"]');
    assert.ok(await p.isVisible("#group-edit"), "the group settings open");
    assert.equal(await p.evaluate(() => document.activeElement.id), "ge-name");
    await p.keyboard.type("工作");
    await expandLibrary(p, "#ge-colors");
    await p.click('#ge-colors .uc-swatch[data-color="#8b5cf6"]');
    await p.keyboard.press("Escape");
    assert.ok(await p.isHidden("#group-edit"));
    assert.deepEqual(await strip(p), ["a", "[工作]", "b", "c", "d", "e"]);

    // 移到分组:放到组里最后一页后面
    await p.click("#tabs .tab:nth-child(6)", { button: "right" });
    assert.ok((await menu(p)).includes("移到分组「工作」"));
    await p.click('#ctx button:has-text("移到分组「工作」")');
    assert.deepEqual(await strip(p), ["a", "[工作]", "b", "e", "c", "d"]);
    // 分组的 id 是随机的,只比较哪些页面在分组里
    await until(
      async () => {
        const s = await stored(h);
        return [s.order, s.groups, Object.keys(s.note_groups || {}).sort()];
      },
      [["a", "b", "e", "c", "d"], [["工作", "#8b5cf6", false]], ["b", "e"]],
      "saved with the notebook",
    );

    // 点分组的名字折叠:只剩当前页面以外的标签都收起来
    await p.click(".tab-group");
    assert.deepEqual(await strip(p), ["a", "[工作2]", "(b)", "(e)", "c", "d"]);
    await until(async () => (await stored(h)).groups, [["工作", "#8b5cf6", true]], "folding is saved");
    // 换到折叠起来的组里的页面时自动展开
    await p.keyboard.press("Control+Tab");
    assert.deepEqual(await strip(p), ["a", "[工作]", "b", "e", "c", "d"]);

    await p.reload();
    await p.waitForSelector("#tabs .tab");
    assert.deepEqual(await strip(p), ["a", "[工作]", "b", "e", "c", "d"], "still there after a restart");
    assert.equal(await p.$eval(".tab-group", (c) => c.style.getPropertyValue("--g")), "#8b5cf6");
  });

  ui("groups: dragging a tab next to a grouped tab joins the group; 移出分组 and 取消分组 take tabs out", { seed: books({ tab_groups: true }, { groups: [{ id: "g1", name: "组", color: "#4c8bf5", collapsed: false }], note_groups: { b: "g1", c: "g1" } }) }, async (h) => {
    const { p } = h;
    // 窗口放宽,标签栏不用滚动(在滚动的标签栏上 Playwright 会拖错标签)
    await p.setViewportSize({ width: 700, height: 540 });
    assert.deepEqual(await strip(p), ["a", "[组]", "b", "c", "d", "e"]);
    await p.dragAndDrop("#tabs .tab:nth-child(6)", "#tabs .tab:nth-child(3)", { targetPosition: { x: 30, y: 10 } });
    assert.deepEqual(await strip(p), ["a", "[组]", "b", "e", "c", "d"], "e joined the group");
    await p.click("#tabs .tab:nth-child(3)", { button: "right" });
    await p.click('#ctx button[data-act="group-leave"]');
    assert.deepEqual(await strip(p), ["a", "[组]", "e", "c", "b", "d"], "b leaves and goes after the group");
    // 新建页面跟着当前页面进同一个组
    await p.click("#tabs .tab:nth-child(3)");
    await p.keyboard.press("Control+t");
    await p.keyboard.press("Enter");
    assert.deepEqual(await strip(p), ["a", "[组]", "e", "新页面", "c", "b", "d"]);
    await p.click(".tab-group", { button: "right" });
    await p.click("#ge-ungroup");
    assert.deepEqual(await strip(p), ["a", "e", "新页面", "c", "b", "d"]);
    await until(async () => (await stored(h)).groups, [], "the empty group is gone");
  });

  ui("groups: turning them off hides the groups but keeps them for later", { seed: books({ tab_groups: true, tab_group_style: "tint" }, { groups: [{ id: "g1", name: "组", color: "#4c8bf5", collapsed: true }], note_groups: { b: "g1", c: "g1" } }) }, async (h) => {
    const { p } = h;
    assert.equal(await p.evaluate(() => document.documentElement.dataset.groupStyle), "tint");
    assert.deepEqual(await strip(p), ["a", "[组2]", "(b)", "(c)", "d", "e"]);
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.ok(await p.isChecked("#set-tab-groups"));
    await p.uncheck("#set-tab-groups");
    assert.ok(await p.isDisabled("#set-group-style"));
    await p.click("#set-save");
    await until(() => strip(p), ["a", "b", "c", "d", "e"], "no groups shown");
    await p.click("#tabs .tab:nth-child(2)", { button: "right" });
    assert.deepEqual(await menu(p), ["重命名", "固定标签", "移到笔记本…", "在小窗中打开", "删除页面"]);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(500);
    assert.equal((await stored(h)).groups.length, 1, "the group is still saved");
    await p.click("#btn-settings");
    await p.check("#set-tab-groups");
    await p.click("#set-save");
    await until(() => strip(p), ["a", "[组2]", "(b)", "(c)", "d", "e"], "and back when turned on");
  });

  ui("groups: in the side list the group names head their pages, and the list shows the group colours", { seed: books({ tab_groups: true, tab_overflow: "drawer" }, { groups: [{ id: "g1", name: "组", color: "#4c8bf5", collapsed: false }], note_groups: { b: "g1", c: "g1" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-pages");
    assert.deepEqual(await strip(p), ["a", "[组]", "b", "c", "d", "e"]);
    await p.fill("#dr-filter", "d");
    assert.deepEqual(await p.$$eval("#tabs > :not(.filtered)", (els) => els.map((e) => e.textContent)), ["d"], "a group with no match hides its name too");
  });
});

describe("v0.3.4 group gradient direction", () => {
  ui("group underline and tint honor a custom gradient angle and stop positions", {
    seed: (() => {
      const db = seed({ "": { a: "a", b: "b" } });
      db.settings.tab_groups = true;
      Object.assign(db.books[""].meta, {
        groups: [{ id: "g1", name: "组", color: "linear-gradient(45deg, #112233 0%, #445566 25%, #778899 100%)", collapsed: false }],
        note_groups: { b: "g1" },
      });
      return db;
    })(),
  }, async ({ p }) => {
    const gradients = await p.$eval(".tab-group", (el) =>
      ["--g-grad", "--g-soft", "--g-soft2", "--g-tint"].map((name) => el.style.getPropertyValue(name)));
    assert.equal(gradients[0], "linear-gradient(45deg, #112233 0%, #445566 25%, #778899 100%)");
    for (const value of gradients.slice(1)) {
      assert.match(value, /^linear-gradient\(45deg, /, "soft backgrounds use the same custom direction as the underline");
      assert.match(value, /25%/, "custom node positions remain intact");
    }
  });
});

describe("0.3.2: floating format buttons on a selection", () => {
  const select = async (p) => {
    await p.click("#editor .ProseMirror p >> nth=-1");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+ArrowLeft");
    await p.keyboard.press("Shift+ArrowLeft");
  };
  const buttons = (p) => p.$$eval("#toolbar > *", (els) => els.map((e) => (e.classList.contains("sep") ? "|" : e.dataset.cmd)));

  ui("selection bar: shows common formats even with the format bar open, including colours", { seed: seed({ "": { 页: "第一段\n\n第二段\n\n一段文字" } }) }, async (h) => {
    const { p } = h;
    assert.ok(await p.isVisible("#format-bar"));
    await p.click("#editor .ProseMirror p >> nth=-1");
    assert.ok(await p.isHidden("#toolbar"), "nothing without a selection");
    await select(p);
    await p.locator("#toolbar").waitFor();
    assert.deepEqual(await buttons(p), ["block", "strong", "em", "strike", "code", "link", "|", "color", "bg"]);
    const bar = await p.locator("#toolbar").boundingBox();
    const sel = await p.evaluate(() => window.getSelection().getRangeAt(0).getBoundingClientRect().top);
    assert.ok(bar.y + bar.height <= sel, "above the selection");
    await p.click('#toolbar [data-cmd="strong"]');
    assert.equal(await h.editor(), "第一段\n\n第二段\n\n一段**文字**");
    await p.click('#toolbar [data-cmd="color"]');
    await p.locator(".fb-pop:not([hidden])").waitFor();
    await expandLibrary(p, ".fb-pop:not([hidden])");
    await expandLibrary(p, ".fb-pop .shared-colors");
    await showKind(p, ".fb-pop:not([hidden])", "gradient");
    await p.click('.fb-pop:not([hidden]) .uc-swatch[data-color^="linear-gradient("] >> nth=0');
    await until(async () => (await h.editor()).includes("linear-gradient"), true, "a gradient colour from the floating buttons");
    assert.ok(await p.isVisible("#toolbar"), "the buttons stay for the selection");
  });

  ui("selection bar: the buttons, their order, the position, and turning it off are in the settings", { seed: seed({ "": { 页: "一段文字" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.inputValue("#set-sel-bar"), "always");
    await p.uncheck('#set-sel-items input[value="block"]');
    await p.uncheck('#set-sel-items input[value="link"]');
    await p.check('#set-sel-items input[value="ol"]');
    assert.equal(await p.$eval("#set-sel-preview", (el) => el.querySelectorAll(".b").length), 7, "the preview follows");
    await p.selectOption("#set-sel-pos", "below");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.sel_bar_items, ["strong", "em", "strike", "code", "sep3", "color", "bg", "ol"], "saved in order");
    await select(p);
    await p.locator("#toolbar").waitFor();
    assert.deepEqual(await buttons(p), ["strong", "em", "strike", "code", "|", "color", "bg", "ol"]);
    const bar = await p.locator("#toolbar").boundingBox();
    const sel = await p.evaluate(() => window.getSelection().getRangeAt(0).getBoundingClientRect().bottom);
    assert.ok(bar.y >= sel, "below the selection");

    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    await p.selectOption("#set-sel-bar", "off");
    assert.ok(await p.isDisabled("#set-sel-pos"));
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.sel_bar, "off", "saved");
    await select(p);
    await sleep(200);
    assert.ok(await p.isHidden("#toolbar"), "no floating buttons when turned off");
  });

  ui("groups: choosing a gradient angle applies it to line and tint and persists", {
    seed: { ...seed({ "": { a: "a", b: "b" } }), settings: { ...SETTINGS, tab_groups: true } },
  }, async (h) => {
    const { p } = h;
    await p.click("#tabs .tab:nth-child(1)", { button: "right" });
    await p.click('#ctx button[data-act="group-new"]');
    await expandLibrary(p, "#ge-colors");
    await showKind(p, "#ge-colors", "gradient");
    await p.click('#ge-colors .uc-swatch[data-color="linear-gradient(135deg, #5fb4ff, #d66cf0)"]');
    await expandLibrary(p, "#ge-colors .shared-colors");
    const editor = p.locator("#ge-colors .shared-colors");
    await editor.locator(":scope > .uc-actions button").first().click();
    assert.equal(await editor.locator('input[aria-label="渐变角度"]').inputValue(), "135", "the group preset keeps its saved angle");
    await editor.locator('input[aria-label="渐变角度"]').fill("215");
    await editor.locator('input[aria-label="渐变角度"]').dispatchEvent("change");
    await editor.locator(".uc-editor .uc-actions .primary").click();
    const expected = "linear-gradient(215deg, #5fb4ff 0%, #d66cf0 100%)";
    await until(async () => (await h.stored())?.books?.[""]?.meta?.groups?.[0]?.color, expected);
    const gradients = await p.$eval(".tab-group", (el) =>
      ["--g-grad", "--g-soft", "--g-soft2", "--g-tint"].map((key) => el.style.getPropertyValue(key)));
    assert.equal(gradients[0], expected, "the group underline respects the chosen angle");
    for (const css of gradients.slice(1)) {
      assert.match(css, /^linear-gradient\(215deg, /, "tinted backgrounds use the same angle");
      assert.match(css, /0%.*100%/, "stop positions remain intact");
    }
  });

  ui("groups: a group can be a gradient, from the presets or a custom one", { seed: { ...seed({ "": { a: "a", b: "b" } }), settings: { ...SETTINGS, tab_groups: true } } }, async (h) => {
    const { p } = h;
    await p.click("#tabs .tab:nth-child(1)", { button: "right" });
    await p.click('#ctx button[data-act="group-new"]');
    await expandLibrary(p, "#ge-colors");
    await showKind(p, "#ge-colors", "gradient");
    await p.click('#ge-colors .uc-swatch[data-color="linear-gradient(135deg, #5fb4ff, #d66cf0)"]');
    await until(async () => (await h.stored())?.books?.[""]?.meta?.groups?.[0]?.color, "linear-gradient(135deg, #5fb4ff, #d66cf0)", "a preset gradient");
    assert.match(await p.$eval(".tab-group", (c) => c.style.getPropertyValue("--g-grad")), /#5fb4ff, #d66cf0/);
    await expandLibrary(p, "#ge-colors .shared-colors");
    const editor = p.locator("#ge-colors .shared-colors");
    assert.equal(await p.locator("#ge-colors .ge-custom").count(), 0, "no duplicate old custom picker");
    await editor.locator(":scope > .uc-actions button").first().click();
    await editor.locator("select").selectOption("gradient");
    await editor.locator(".uc-editor .uc-actions .primary").click();
    await until(async () => (await h.stored())?.books?.[""]?.meta?.groups?.[0]?.color?.includes(" 0%"), true, "a custom gradient");
    await expandLibrary(p, "#ge-colors .shared-colors");
    await editor.locator(":scope > .uc-actions button").first().click();
    await editor.locator("select").selectOption("solid");
    await editor.locator(".uc-editor .uc-actions .primary").click();
    await until(async () => /^#[0-9a-f]{6}$/.test((await h.stored())?.books?.[""]?.meta?.groups?.[0]?.color), true, "or a single colour");
  });
});

// ---------- 0.3.6:打字更快、改名删除时的保存、启动提示、颜色细节 ----------
describe("0.3.6: speed and safety", () => {
  const saves = (p) => p.evaluate(() => window.__mockControl.calls.filter((c) => c === "save_note").length);

  ui("typing then switching pages right away keeps every character", { seed: seed({ "": { 甲: "一", 乙: "二" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("End");
    await p.keyboard.type("加的字");
    await h.tab("乙").click();
    await h.tab("甲").click();
    assert.equal(await h.editor(), "一加的字", "the text is still there after switching back");
    await until(() => h.mockFile("", "甲"), "一加的字", "and it is saved");
  });

  ui("typing then searching right away finds the new text", { seed: seed({ "": { 页: "开头" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("End");
    await p.keyboard.type("独一无二");
    await p.keyboard.press("Control+Shift+KeyF");
    await p.locator("#search-input").waitFor();
    await p.keyboard.type("独一无二");
    await until(() => p.$$eval("#search-results .result .where", (els) => els.map((e) => e.textContent.trim())), ["页 · 第 1 行"], "found in the page being edited");
    await p.keyboard.press("Escape");
  });

  ui("a page that was just typed into is not deleted as a blank page", { seed: seed({ "": { 甲: "", 乙: "二" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror");
    await p.keyboard.type("刚写的");
    await h.tabMenu("甲");
    await p.click('#ctx button[data-act="delete"]');
    await p.locator("#dialog").waitFor();
    assert.match(await p.textContent("#dialog"), /删除页面「甲」\?/, "asks like for a page with content");
    await p.keyboard.press("Escape");
  });

  ui("changing a page and changing it back does not rewrite the file", { seed: seed({ "": { 页: "原样" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { calls: [] }; });
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("End");
    await p.keyboard.type("x");
    await p.keyboard.press("Backspace");
    await until(() => p.textContent("#st-save"), "已保存", "nothing left to save");
    assert.equal(await saves(p), 0, "no save_note call");
    assert.equal(await h.mockFile("", "页"), "原样");
  });

  ui("typing without a pause is still saved every few seconds", { seed: seed({ "": { 页: "" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror");
    let saved = false;
    for (let i = 0; i < 30 && !saved; i++) {
      await p.keyboard.type("字");
      await sleep(250);
      saved = !!(await h.mockFile("", "页"));
    }
    assert.ok(saved, "saved while still typing");
  });

  ui("the word count shows the characters you see, not the Markdown marks", { seed: seed({ "": { 页: "**粗体**和`代码`" } }) }, async (h) => {
    const { p } = h;
    await until(() => p.textContent("#st-count"), "5 字", "counts 粗体和代码");
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("End");
    await p.keyboard.type("👍");
    await until(() => p.textContent("#st-count"), "6 字", "an emoji counts as one");
  });

  ui("a page that can't be read is not changed by F5 or the format bar either", { seed: seed({ "": { 好页: "正常", 坏页: "磁盘原内容" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { unreadable: { "": { 坏页: "模拟访问被拒绝" } }, calls: [] }; });
    await h.sync();
    await until(() => p.locator(".tab.unreadable").count(), 1, "warning tab appears");
    await h.tab("坏页").click();
    const before = await h.editor();
    await p.keyboard.press("F5");
    await p.$eval('#format-bar [data-cmd="hr"]', (b) => b.click());
    assert.equal(await h.editor(), before, "the content did not change");
    await p.keyboard.press("Control+s");
    assert.equal(await saves(p), 0, "nothing is saved");
  });

  ui("typing during a slow rename is saved under the new name afterwards", { seed: seed({ "": { 甲: "一", 丙: "三" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => { window.__mockControl = { delay: { rename_note: 2000 }, calls: [] }; });
    await h.tab("甲").dblclick();
    await p.locator("#tabs .tab input").waitFor();
    await p.fill("#tabs .tab input", "乙");
    await p.press("#tabs .tab input", "Enter");
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("End");
    await p.keyboard.type("二");
    await sleep(900);
    assert.equal(await saves(p), 0, "no save while the page is being renamed");
    await until(() => h.mockFile("", "乙"), "一二", "saved under the new name once the rename is done");
    assert.equal(await h.mockFile("", "甲"), null, "the old file is not written back");
  });

  ui("a notice from startup is shown, and waits until the window is shown", async (h) => {
    const { p } = h;
    await p.context().addInitScript(() => { window.__mockControl = { settingsNotice: "设置文件读取失败,已改名留底" }; });
    await p.reload();
    await p.waitForSelector("#tabs .tab", { state: "attached" });
    await until(h.toast, "设置文件读取失败,已改名留底", "shown right away when the window has focus");

    await p.context().addInitScript(() => { document.hasFocus = () => false; });
    await p.reload();
    await p.waitForSelector("#tabs .tab", { state: "attached" });
    await sleep(200);
    assert.equal(await h.toast(), "", "hidden window: not shown yet");
    await p.evaluate(() => window.__mockEmit("window-focus"));
    await until(h.toast, "设置文件读取失败,已改名留底", "shown when the window gets focus");
  });

  ui("page titles in search results are shown in full", { seed: seed({ "": { 首页: "x", ["很长的页面标题".repeat(8)]: "y" } }) }, async (h) => {
    const { p } = h;
    await p.keyboard.press("Control+Shift+KeyF");
    await p.locator("#search-input").waitFor();
    await p.keyboard.type("很长的页面标题");
    const title = p.locator("#search-results .result .snip.title");
    await title.waitFor();
    assert.equal(await title.evaluate((e) => e.scrollWidth <= e.clientWidth && e.textContent.length), 56, "the whole title, wrapped");
    await p.keyboard.press("Escape");
  });

  const accentFg = (p) => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent-fg").trim());
  ui("text on a very light accent color is dark", { seed: { ...seed({ "": { 页: "正文" } }), settings: { ...SETTINGS, accent: "#f5d142" } } }, async ({ p }) => {
    assert.equal(await accentFg(p), "#2b2a26", "dark text on yellow");
  });

  ui("text on a darker accent color stays white", { seed: { ...seed({ "": { 页: "正文" } }), settings: { ...SETTINGS, accent: "#3b82f6" } } }, async ({ p }) => {
    assert.equal(await accentFg(p), "#fff", "white text on blue");
  });

  ui("lit toolbar icons follow the accent gradient's angle", { seed: { ...seed({ "": { 页: "正文" } }), settings: { ...SETTINGS, accent: "linear-gradient(90deg, #4facfe, #00c6fb)" } } }, async (h) => {
    const { p } = h;
    const line = await p.$eval("#accent-svg-grad", (g) => ["x1", "y1", "x2", "y2"].map((a) => g.getAttribute(a)));
    assert.deepEqual(line, ["1", "8", "15", "8"], "90deg runs from left to right");
  });

  ui("background colors are toned down in the dark theme, solid or gradient", { seed: { ...seed({ "": { 页: '<span style="background-color: #fbe9a6">黄底</span>' } }), settings: { ...SETTINGS, theme: "dark" } } }, async (h) => {
    const { p } = h;
    const span = p.locator("#editor span[data-bg]");
    await span.waitFor();
    const bg = await span.evaluate((e) => ({ image: getComputedStyle(e).backgroundImage, color: getComputedStyle(e).backgroundColor }));
    assert.match(bg.image, /^linear-gradient\(/, "a dimming layer on top");
    assert.equal(bg.color, "rgb(251, 233, 166)", "over the chosen color");
  });
});

describe("0.3.10: trash, backup notes, import staging, quick switch, pinned tabs, edge button", () => {
  ui("trash: deleted pages and notebooks are listed, restored to where they were, or deleted for good", { seed: seed({ "": { 首页: "hello", 草稿: "第一行\n第二行" }, 工作: { 周报: "本周", 计划: "下周" }, 旧的: { a: "1", b: "2" } }) }, async (h) => {
    const { p } = h;
    await h.tab("草稿").click();
    await p.keyboard.press("Control+w");
    await p.locator("#dialog").waitFor();
    assert.match(await p.textContent("#dialog-msg"), /回收站/);
    await p.click("#dialog-ok");
    await until(h.tabs, ["首页"], "page deleted");
    await h.bookMenu("旧的");
    await p.click('#ctx button[data-act="delete"]');
    await p.click("#dialog-ok");
    await until(async () => (await h.listBooks()).map((b) => b.name), ["默认", "工作"], "notebook deleted");

    await h.openBooks();
    await p.click("#books-trash");
    await p.locator("#trash").waitFor();
    assert.ok(await p.isHidden("#books"));
    const rows = () => p.$$eval("#trash-list .trash-item", (els) => els.map((e) => [e.dataset.kind, e.querySelector(".ti-name").textContent]));
    await until(async () => (await rows()).sort(), [["book", "旧的"], ["page", "草稿"]], "both are in the trash");
    assert.equal(await p.textContent("#trash-count"), "2 项");
    const draft = p.locator('.trash-item:has-text("草稿")');
    assert.match(await draft.locator(".ti-meta").textContent(), /^来自「默认」 · .+ 删除$/);
    assert.equal(await draft.locator(".ti-preview").textContent(), "第一行 第二行");
    assert.match(await p.locator('.trash-item:has-text("旧的") .ti-meta').textContent(), /^笔记本 · 2 页/);
    // 筛选
    await p.fill("#trash-filter", "旧");
    assert.deepEqual(await rows(), [["book", "旧的"]]);
    await p.fill("#trash-filter", "");

    // 页面回到原来的笔记本,打开它
    await draft.locator('button[data-act="restore"]').click();
    await until(h.tabs, ["首页", "草稿"], "page is back");
    assert.equal(await h.mockFile("", "草稿"), "第一行\n第二行");
    await until(rows, [["book", "旧的"]], "only the notebook is left");
    assert.match(await h.toast(), /已恢复「默认」里的「草稿」/);
    // 彻底删除要先确认
    await p.click('.trash-item:has-text("旧的") button[data-act="purge"]');
    await p.locator("#dialog").waitFor();
    assert.match(await p.textContent("#dialog-msg"), /彻底删除笔记本「旧的」和里面的 2 页/);
    assert.ok(await p.isVisible("#trash"), "the trash stays open behind the question");
    await p.click("#dialog-cancel");
    assert.equal((await rows()).length, 1);
    await p.click('.trash-item:has-text("旧的") button[data-act="purge"]');
    await p.click("#dialog-ok");
    await until(rows, [], "deleted for good");
    assert.equal(await p.getAttribute("#trash-list", "data-empty"), "回收站是空的");
    assert.ok(await p.isDisabled("#trash-empty"));
    await p.keyboard.press("Escape");
    await until(() => p.isHidden("#trash"), true, "Esc closes the trash");
  });

  ui("trash: a notebook comes back with its pages; from the settings the trash opens on top and Esc returns there; empty it all", { seed: seed({ "": { 首页: "hello" }, 旧的: { a: "1", b: "2" }, 工作: { 周报: "本周" } }) }, async (h) => {
    const { p } = h;
    await h.bookMenu("旧的");
    await p.click('#ctx button[data-act="delete"]');
    await p.click("#dialog-ok");
    await until(async () => (await h.listBooks()).map((b) => b.name), ["默认", "工作"], "notebook deleted");
    await h.openBooks();
    await p.click("#books-trash");
    await p.click('.trash-item:has-text("旧的") button[data-act="restore"]');
    await until(h.bookName, "旧的", "the restored notebook opens");
    assert.deepEqual(await h.tabs(), ["a", "b"]);
    await p.keyboard.press("Escape");

    await h.switchBook("工作");
    await p.keyboard.press("Control+w");
    await p.click("#dialog-ok");
    await h.switchBook("");
    await p.keyboard.press("Control+w");
    await p.click("#dialog-ok");
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await p.click("#set-trash");
    await p.locator("#trash").waitFor();
    assert.ok(await p.isVisible("#settings"), "settings stay open underneath");
    await until(() => p.$$eval("#trash-list .trash-item", (els) => els.length), 2, "two pages");
    // 从设置里恢复不换页面
    await p.click('.trash-item:has-text("周报") button[data-act="restore"]');
    await until(() => h.mockFile("工作", "周报"), "本周", "restored into 工作");
    assert.equal(await h.bookName(), "默认");
    await p.click("#trash-empty");
    assert.match(await p.textContent("#dialog-msg"), /清空回收站,彻底删除这 1 项/);
    await p.click("#dialog-ok");
    await until(() => p.$$eval("#trash-list .trash-item", (els) => els.length), 0, "emptied");
    await p.keyboard.press("Escape");
    await until(() => p.isHidden("#trash"), true);
    assert.ok(await p.isVisible("#settings"), "back in the settings");
    assert.equal(await p.evaluate(() => document.activeElement.id), "set-trash");
  });

  ui("backup: files the daily backup could not read are listed in the settings and announced", { seed: seed({ "": { 首页: "hello" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => (window.__mockControl = { backupSkipped: ["工作/锁着.md", "照片/"] }));
    await h.tab("首页").click();
    await p.keyboard.type("x");
    await p.evaluate(() => window.__minipad.flush());
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await until(() => p.isVisible("#set-backup-skipped"), true, "the list shows up");
    const text = await p.textContent("#set-backup-skipped");
    assert.match(text, /今天的备份跳过了 2 个读不了的文件或文件夹/);
    assert.match(text, /· 工作\/锁着\.md\n· 照片\//);
    await p.uncheck("#set-backup");
    assert.ok(await p.isHidden("#set-backup-skipped"), "not shown while backups are off");
    await p.click("#set-cancel");
    // 后端打完备份发来的提示
    await p.evaluate(() => window.__mockEmit("backup-skipped", ["a.md"]));
    assert.match(await h.toast(), /今天的备份跳过了 1 个读不了的文件或文件夹[\s\S]*· a\.md/);
  });

  ui("quick switch: Ctrl+P finds a page in any notebook by name, recent pages first; Enter opens it", { seed: seed({ "": { 首页: "hello", 购物清单: "x" }, 工作: { 周报: "本周", 会议记录: "y" }, 生活: { 周末计划: "z" } }) }, async (h) => {
    const { p } = h;
    await h.switchBook("工作");
    await h.tab("会议记录").click();
    await h.switchBook("");
    await p.keyboard.press("Control+p");
    await p.locator("#quick").waitFor();
    assert.equal(await p.evaluate(() => document.activeElement.id), "quick-input");
    const names = () => p.$$eval("#quick-results .result .snip", (els) => els.map((e) => e.textContent));
    const first = await names();
    assert.equal(first[0], "会议记录", "the most recently opened page first");
    assert.ok(!first.includes("首页"), "not the page that is open now");
    assert.equal(await p.textContent("#quick-results .result >> nth=0 >> .where"), "工作 · 最近打开");
    await p.keyboard.type("周");
    await until(names, ["周报", "周末计划"], "pages whose names start with it");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Enter");
    await until(h.bookName, "生活", "jumps to the notebook");
    assert.equal(await h.activeTab(), "周末计划");
    assert.ok(await p.isHidden("#quick"));
    assert.ok(await h.editorFocused());
    // 笔记本名字也能用来找;字可以不挨着
    await p.keyboard.press("Control+p");
    await p.keyboard.type("工作 会记");
    await until(names, ["会议记录"]);
    await p.keyboard.press("Escape");
    await until(() => p.isHidden("#quick"), true, "Esc closes it");
    await p.keyboard.press("Control+p");
    await p.keyboard.type("没有这页");
    await until(() => p.getAttribute("#quick-results", "data-empty"), "没有找到");
    assert.deepEqual(await names(), []);
    // 再按一次快捷键也关掉
    await p.keyboard.press("Control+p");
    await until(() => p.isHidden("#quick"), true);
  });

  ui("quick switch: the shortcut can be changed or turned off, and it can look only in the current notebook", { seed: seed({ "": { 首页: "hello", 周记: "a" }, 工作: { 周报: "本周" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    assert.equal(await p.inputValue("#set-quick-key"), "Ctrl+P");
    await settingsPage(p, "general");
    await p.click("#set-quick-key");
    await p.keyboard.press("Control+Shift+KeyO");
    assert.equal(await p.inputValue("#set-quick-key"), "Ctrl+Shift+O");
    await p.selectOption("#set-quick-scope", "book");
    await p.click("#set-save");
    await until(() => p.isHidden("#settings"), true);
    await p.keyboard.press("Control+p");
    await sleep(150);
    assert.ok(await p.isHidden("#quick"), "the old shortcut does nothing now");
    await p.keyboard.press("Control+Shift+KeyO");
    await p.locator("#quick").waitFor();
    await p.keyboard.type("周");
    await until(() => p.$$eval("#quick-results .result .snip", (els) => els.map((e) => e.textContent)), ["周记"], "only this notebook");
    assert.equal(await p.locator("#quick-results .where").count(), 0, "no notebook names needed");
    await p.keyboard.press("Escape");
    // 清空就不用快捷键
    await p.click("#btn-settings");
    await settingsPage(p, "general");
    await p.click("#set-quick-key");
    await p.keyboard.press("Backspace");
    assert.equal(await p.inputValue("#set-quick-key"), "");
    await p.click("#set-save");
    await until(() => p.evaluate(() => window.__minipad.state.settings.quick_switch_key), "");
    await p.keyboard.press("Control+Shift+KeyO");
    await sleep(150);
    assert.ok(await p.isHidden("#quick"));
  });

  ui("pinned tabs: pinning moves a tab to the front with a pin, survives a reload, and Ctrl+W will not delete it", { seed: seed({ "": { 甲: "a", 乙: "b", 丙: "c" } }) }, async (h) => {
    const { p } = h;
    await h.tabMenu("丙");
    await p.click('#ctx button[data-act="pin"]');
    await until(h.tabs, ["丙", "甲", "乙"], "pinned tab goes first");
    assert.ok(await h.tab("丙").evaluate((t) => t.classList.contains("pinned") && t.classList.contains("pin-end")));
    assert.ok(await h.tab("丙").locator(".pin-mark").isVisible(), "a pin before the name");
    await h.tabMenu("乙");
    await p.click('#ctx button[data-act="pin"]');
    await until(h.tabs, ["丙", "乙", "甲"], "the second pinned tab goes after the first");
    await until(async () => (await h.stored())?.books[""].meta.pinned, ["丙", "乙"], "saved with the notebook");
    // 不能被 Ctrl+W 删掉,右键菜单里的删除也是灰的
    await h.tab("乙").click();
    await p.keyboard.press("Control+w");
    assert.match(await h.toast(), /「乙」是固定的标签,先右键取消固定才能删除/);
    assert.ok(await p.isHidden("#dialog"));
    await h.tabMenu("乙");
    assert.equal(await p.textContent('#ctx button[data-act="pin"]'), "取消固定");
    assert.ok(await p.isDisabled('#ctx button[data-act="delete"]'));
    await p.keyboard.press("Escape");
    // 普通的标签拖不到固定的前面(窗口放宽,标签栏不用滚动)
    await p.setViewportSize({ width: 700, height: 540 });
    await p.dragAndDrop("#tabs .tab:nth-child(3)", "#tabs .tab:nth-child(1)", { targetPosition: { x: 4, y: 10 } });
    await until(h.tabs, ["丙", "乙", "甲"], "stays after the pinned ones");
    await p.reload();
    await until(h.tabs, ["丙", "乙", "甲"], "still pinned after a reload");
    assert.equal(await p.locator("#tabs .tab.pinned").count(), 2);
    // 取消固定:放到固定的后面
    await h.tabMenu("丙");
    await p.click('#ctx button[data-act="pin"]');
    await until(h.tabs, ["乙", "丙", "甲"]);
    await until(async () => (await h.stored())?.books[""].meta.pinned, ["乙"]);
  });

  ui("pinned tabs: the mark style is a setting", { seed: { ...seed({ "": { 甲: "a", 乙: "b" } }), settings: { ...SETTINGS, pin_style: "tint" } } }, async (h) => {
    const { p } = h;
    await h.tabMenu("乙");
    await p.click('#ctx button[data-act="pin"]');
    await h.tab("甲").click();
    assert.equal(await p.evaluate(() => document.documentElement.dataset.pinStyle), "tint");
    assert.ok(!(await h.tab("乙").locator(".pin-mark").isVisible()), "no pin with the tint style");
    assert.notEqual(await h.tab("乙").evaluate((t) => getComputedStyle(t).backgroundColor), "rgba(0, 0, 0, 0)", "tinted");
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.equal(await p.inputValue("#set-pin-style"), "tint");
    await p.selectOption("#set-pin-style", "icon");
    await p.click("#set-save");
    await until(() => h.tab("乙").locator(".pin-mark").isVisible(), true, "pin shows after switching the style");
  });

  ui("edge button: one click keeps the window shown, another brings edge hiding back; it can be hidden in the settings", { seed: seed({ "": { 首页: "hello" } }) }, async (h) => {
    const { p } = h;
    const btn = p.locator("#btn-edge");
    assert.ok(await btn.isVisible(), "shown by default");
    assert.equal(await btn.getAttribute("aria-pressed"), "true");
    assert.ok(await btn.evaluate((b) => b.classList.contains("on")));
    await btn.click();
    await until(() => p.evaluate(() => window.__minipad.state.settings.edge_hide), false, "edge hiding off");
    assert.equal(await btn.getAttribute("aria-pressed"), "false");
    assert.match(await btn.getAttribute("title"), /^一直显示/);
    assert.match(await h.toast(), /一直显示/);
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    assert.ok(!(await p.isChecked("#set-edge")), "the setting follows the button");
    await p.check("#set-edge");
    await p.uncheck("#set-edge-button");
    await p.click("#set-save");
    await until(() => btn.isHidden(), true, "button hidden");
    assert.equal(await p.evaluate(() => window.__minipad.state.settings.edge_hide), true);
  });
});

describe("0.3.11: quick colors keep their place in the library", () => {
  const LIB = ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777", "#888888"];

  ui("× on a quick color takes it out of quick without pulling another in, and it shows again where it was", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, color_library: LIB } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const palette = p.locator("#set-accent + .shared-colors");
    await expandLibrary(p, "#set-accent + .shared-colors");
    // 先把后面的 #777777 拖进快捷栏，再按 × 移出：它回到 #666666 和 #888888 中间
    await palette.locator('.uc-preset[data-color="#777777"]').dragTo(palette.locator('.uc-kind-title[data-section="quick"]'));
    await until(async () => sectionColors(palette, "quick"), [...LIB.slice(0, 5), "#777777"]);
    for (const color of ["#777777", "#333333"]) {
      await palette.locator(`.uc-swatch[data-color="${color}"]`).hover();
      await palette.locator(`.uc-preset[data-color="${color}"] .uc-delete`).click();
    }
    await until(async () => (await h.stored()).settings.quick_colors, ["#111111", "#222222", "#444444", "#555555"],
      "four quick colors are left; #666666 does not move up");
    assert.deepEqual(await sectionColors(palette, "solid"), ["#333333", "#666666", "#777777", "#888888"],
      "both are back in their old places");
    assert.deepEqual((await h.stored()).settings.color_library, LIB, "nothing is deleted from the library");
    const titles = await palette.locator('[data-section="quick"] ~ .uc-preset .uc-delete').evaluateAll((nodes) =>
      nodes.map((node) => node.title));
    assert.ok(titles.includes("移出快捷栏（回到原来的位置）") && titles.includes("删除颜色预设"),
      "quick × and library × say what they do");
    await p.reload();
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    assert.deepEqual(await palette.locator(".uc-preset:visible .uc-swatch").evaluateAll((nodes) =>
      nodes.map((el) => el.dataset.color)), ["#111111", "#222222", "#444444", "#555555"], "still four after a restart");
  });

  ui("editing a quick color keeps it in the same quick place", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, color_library: LIB, quick_colors: ["#333333", "#111111"] } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const palette = p.locator("#set-accent + .shared-colors");
    await palette.locator('.uc-swatch[data-color="#111111"]').click({ button: "right" });
    await palette.locator('.uc-stop input[type="color"]').first().evaluate((input) => {
      input.value = "#abcdef";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await palette.locator('.uc-editor button:has-text("保存修改")').click();
    await until(async () => (await h.stored()).settings.quick_colors, ["#333333", "#abcdef"]);
    assert.equal((await h.stored()).settings.color_library[0], "#abcdef");
  });

  ui("old libraries get the new gradients once; a deleted one stays deleted", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_library_rev: 0, color_library: ["#111111"], material_library: null,
    } },
  }, async (h) => {
    const { p } = h;
    const added = "linear-gradient(135deg, #1e3c72, #2a5298)";
    await until(async () => (await h.stored())?.settings?.color_library?.length, 25, "the 24 default gradients are added");
    const s = (await h.stored()).settings;
    assert.equal(s.color_library[0], "#111111", "existing colors keep their place");
    assert.ok(s.color_library.includes(added));
    assert.equal(s.color_library_rev, 1);
    assert.equal(s.material_library.length, 18, "the default materials are saved in their own library");
    assert.ok(s.material_library.every((color) => !s.color_library.includes(color)));
    assert.equal(s.quick_colors[0], "#111111", "the old quick color stays");
    assert.equal(s.quick_colors.filter((c) => s.color_library.includes(c) && c.startsWith("linear-gradient")).length, 4,
      "four gradient quick colors are added");
    assert.equal(s.quick_colors.filter((c) => s.material_library.includes(c)).length, 4, "four material quick colors");
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, "#set-accent + .shared-colors");
    const palette = p.locator("#set-accent + .shared-colors");
    await showKind(p, "#set-accent + .shared-colors", "gradient");
    await palette.locator(`.uc-swatch[data-color="${added}"]`).hover();
    await palette.locator(`.uc-preset[data-color="${added}"] .uc-delete`).click();
    await until(async () => (await h.stored()).settings.color_library.includes(added), false);
    await p.reload();
    await p.waitForSelector("#tabs .tab");
    assert.equal((await h.stored()).settings.color_library.includes(added), false, "not added back after a restart");
  });

  ui("each picker remembers its tab, and the open setting can pin one", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, accent: "#3b82f6" } },
  }, async (h) => {
    const { p } = h;
    const accent = "#set-accent + .shared-colors";
    const pressed = (root) => p.locator(`${root} .uc-kind[aria-pressed="true"]`).getAttribute("data-kind");
    const open = async () => {
      await p.click("#btn-settings");
      await settingsPage(p, "look");
    };
    await open();
    assert.deepEqual(await p.locator(`${accent} .uc-kind`).allTextContents(), ["纯色", "渐变", "材质"]);
    assert.equal(await pressed(accent), "solid", "the first time it follows the current color");
    await showKind(p, accent, "material");
    assert.equal(await pressed("#set-edge-color + .shared-colors"), "solid", "other pickers keep their own tab");
    await p.click("#set-cancel");
    await open();
    assert.equal(await pressed(accent), "material", "reopening shows the tab it was left on");
    await p.reload();
    await open();
    assert.equal(await pressed(accent), "material", "and after a restart");
    await p.selectOption("#set-color-open", "gradient");
    await p.click("#set-save");
    await until(async () => (await h.stored()).settings.color_open_tab, "gradient");
    await open();
    assert.equal(await pressed(accent), "gradient", "「总是渐变」 opens every picker on 渐变");
    assert.equal(await pressed("#set-edge-color + .shared-colors"), "gradient");
  });

  ui("colors saved on the 材质 tab go into the material library", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, accent: "linear-gradient(135deg, #010203, #a0b0c0)",
    } },
  }, async (h) => {
    const { p } = h;
    const root = "#set-accent + .shared-colors";
    const value = "linear-gradient(135deg, #010203, #a0b0c0)";
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await expandLibrary(p, root);
    await showKind(p, root, "material");
    assert.ok(await p.isVisible(`${root} .uc-empty`), "an empty material library says so");
    await p.click(`${root} button[title="保存当前颜色"]`);
    await until(async () => (await h.stored()).settings.material_library, [value]);
    assert.equal((await h.stored()).settings.color_library.includes(value), false, "not in the gradient library");
    assert.deepEqual(await sectionColors(p.locator(root), "material"), [value]);
    await showKind(p, root, "gradient");
    assert.equal(await p.locator(`${root} .uc-swatch[data-color="${value}"]`).count(), 0, "the 渐变 tab does not show it");
  });

  ui("each kind can be restored on its own", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_library: ["#111111", "linear-gradient(90deg, #aaaaaa, #bbbbbb)"], quick_colors: ["#111111"],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.click("#set-colors-reset-material");
    assert.match(await p.textContent("#dialog"), /默认材质色/);
    await p.click("#dialog-ok");
    await until(async () => (await h.stored()).settings.material_library?.length, 18);
    let s = (await h.stored()).settings;
    assert.deepEqual(s.color_library, ["#111111", "linear-gradient(90deg, #aaaaaa, #bbbbbb)"], "solids and gradients stay");
    assert.equal(s.quick_colors[0], "#111111");
    assert.deepEqual(s.quick_colors.slice(1).map((c) => s.material_library.indexOf(c)), [0, 1, 2, 12],
      "the default material quick colors come back");
    await p.click("#set-colors-reset-gradient");
    await p.click("#dialog-ok");
    await until(async () => (await h.stored()).settings.color_library?.length, 25);
    s = (await h.stored()).settings;
    assert.equal(s.color_library[0], "#111111", "the solid library is untouched");
    assert.equal(s.color_library.includes("linear-gradient(90deg, #aaaaaa, #bbbbbb)"), false, "own gradients are removed");
    assert.equal(s.material_library.length, 18);
    assert.equal(s.quick_colors.length, 9, "1 solid, 4 default gradients, 4 materials");
  });

  ui("gradient swatches can be bars or circles, and their names show on hover", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, accent: "#3b82f6", material_library: null } },
  }, async (h) => {
    const { p } = h;
    const root = "#set-accent + .shared-colors";
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await showKind(p, root, "gradient");
    const first = p.locator(`${root} .uc-preset:visible .uc-swatch`).first();
    const name = async (swatch) => (await swatch.getAttribute("title")).split("；")[0];
    assert.equal(await name(first), "使用 渐变「彩虹」");
    await p.selectOption("#set-gradient-shape", "bar");
    await until(async () => p.locator(`${root} .uc-preset.bar:visible`).count(), 4, "bars preview right away");
    const width = await p.locator(`${root} .uc-preset.bar`).first().evaluate((el) => el.getBoundingClientRect().width);
    assert.ok(width > 60, "a bar takes two swatch places");
    await p.selectOption("#set-gradient-shape", "round");
    await until(async () => first.evaluate((el) => getComputedStyle(el).borderRadius), "50%");
    await showKind(p, root, "material");
    assert.equal(await name(p.locator(`${root} .uc-preset:visible .uc-swatch`).first()), "使用 材质「银色」");
    await p.uncheck("#set-gradient-names");
    await until(async () => name(p.locator(`${root} .uc-preset:visible .uc-swatch`).first()),
      "使用 " + await p.locator(`${root} .uc-preset:visible .uc-swatch`).first().getAttribute("data-color"));
    await p.click("#set-save");
    await until(async () => (await h.stored()).settings.gradient_shape, "round");
    assert.equal((await h.stored()).settings.gradient_names, false);
  });

  ui("the default library has 24 gradients and 18 materials, and Settings → 外观 can restore it", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: { ...SETTINGS, color_library: ["#111111"], quick_colors: [] } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.click("#set-colors-reset");
    assert.ok(await p.isVisible("#dialog"), "asks first");
    await p.click("#dialog-cancel");
    assert.deepEqual((await h.stored()).settings.color_library, ["#111111"], "cancel keeps the library");
    await p.click("#set-colors-reset");
    await p.click("#dialog-ok");
    await until(async () => (await h.stored()).settings.color_library?.length, 34);
    const s = (await h.stored()).settings;
    assert.equal(s.color_library.filter((c) => c.startsWith("linear-gradient")).length, 24);
    assert.equal(s.material_library.length, 18);
    assert.equal(s.quick_colors.length, 13, "5 solids, 4 gradients and 4 materials");
    assert.deepEqual(s.quick_colors.slice(0, 5), ["#d9822b", "#3b82f6", "#16a34a", "#8b5cf6", "#e5484d"]);
    assert.deepEqual(s.quick_colors.slice(9).map((c) => s.material_library.indexOf(c)), [0, 1, 2, 12],
      "银色、金色、紫金、镭射");
    assert.ok(await p.isVisible("#settings"), "settings stay open");
    assert.equal(await p.locator("#set-accent + .shared-colors .uc-preset:visible").count(), 5);
  });
});

describe("0.3.12: dragging colors in the format bar popup", () => {
  ui("each quick bar ends with a ＋ slot; a color dropped there goes last", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_layout: "rows", color_library: ["#111111", "#222222", "#333333",
        "linear-gradient(90deg, #aaaaaa, #bbbbbb)", "linear-gradient(45deg, #cccccc, #dddddd)"],
      quick_colors: ["#111111", "#222222", "linear-gradient(90deg, #aaaaaa, #bbbbbb)"],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const root = "#set-accent + .shared-colors";
    const lib = p.locator(root);
    assert.equal(await lib.locator(".uc-drop-slot").count(), 0, "no slot while collapsed");
    await expandLibrary(p, root);
    assert.deepEqual(await lib.locator(".uc-drop-slot").evaluateAll((nodes) => nodes.map((n) => n.dataset.kind)),
      ["solid", "gradient", "material"], "one slot at the end of each quick bar");
    const slot = (kind) => lib.locator(`.uc-drop-slot[data-kind="${kind}"]`);
    const gradient = "linear-gradient(45deg, #cccccc, #dddddd)";
    await lib.locator(`.uc-preset[data-color="${gradient}"]`).dragTo(slot("solid"));
    assert.deepEqual((await h.stored()).settings.quick_colors, ["#111111", "#222222", "linear-gradient(90deg, #aaaaaa, #bbbbbb)"],
      "a gradient is not taken by the solid slot");
    await lib.locator('.uc-preset[data-color="#333333"]').dragTo(slot("solid"));
    await until(async () => (await h.stored()).settings.quick_colors,
      ["#111111", "#222222", "#333333", "linear-gradient(90deg, #aaaaaa, #bbbbbb)"]);
    await lib.locator('.uc-preset[data-color="#111111"]').dragTo(slot("solid"));
    await until(async () => sectionColors(lib, "quick").then((c) => c.slice(0, 3)), ["#222222", "#333333", "#111111"],
      "a quick color dropped on the slot moves to the end");
    await lib.locator(`.uc-preset[data-color="${gradient}"]`).dragTo(slot("gradient"));
    await until(async () => (await h.stored()).settings.quick_colors.at(-1), gradient);
  });

  ui("text and background color popups let library colors be dragged into quick, and clicks still color the text", {
    seed: { ...seed({ "": { 页: "文字" } }), settings: {
      ...SETTINGS, color_library: ["#111111", "#222222", "#333333"], quick_colors: ["#111111"],
    } },
  }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("Control+a");
    for (const cmd of ["color", "bg"]) {
      await p.click(`#format-bar [data-cmd="${cmd}"]`);
      await p.locator(".fb-pop:not([hidden])").waitFor();
      const root = ".fb-pop:not([hidden]) .shared-colors";
      const pop = p.locator(root);
      await expandLibrary(p, root);
      await showKind(p, ".fb-pop:not([hidden])", "solid");
      const color = cmd === "color" ? "#222222" : "#333333";
      await pop.locator(`.uc-preset[data-color="${color}"]`).dragTo(pop.locator('.uc-kind-title[data-section="quick"]'));
      await until(async () => (await h.stored()).settings.quick_colors.includes(color), true,
        `a color dragged in the ${cmd} popup becomes a quick color`);
      assert.equal(await p.locator(".fb-pop:not([hidden])").count(), 1, "the popup stays open while dragging");
      await pop.locator('.uc-swatch[data-color="#111111"]').click();
      await until(h.editor, cmd === "color" ? '<span style="color: #111111">文字</span>'
        : '<span style="color: #111111"><span style="background-color: #111111">文字</span></span>',
      "clicking a swatch in the expanded library still colors the selected text");
      await p.keyboard.press("Escape");
    }
    assert.deepEqual((await h.stored()).settings.quick_colors, ["#111111", "#222222", "#333333"]);
  });
});

// ---------- 0.4.0 ----------
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// 在编辑区里粘贴 / 拖进来一张图片文件
function sendImage(p, kind, name = "image.png") {
  return p.evaluate(([png, kind, name]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], name, { type: "image/png" }));
    const target = document.querySelector("#editor .ProseMirror");
    if (kind === "paste") {
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    } else {
      const r = target.querySelector("p").getBoundingClientRect();
      target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: r.right - 1, clientY: r.top + 4, bubbles: true, cancelable: true }));
    }
  }, [PNG, kind, name]);
}
const control = (p, value = {}) => p.evaluate((v) => (window.__mockControl = { calls: [], ...v }), value);
const mockCtl = (p, key) => p.evaluate((k) => window.__mockControl?.[k] ?? null, key);
const miniUrl = (book, page) => `/index.html?mini=1&book=${encodeURIComponent(book)}&page=${encodeURIComponent(page)}`;

describe("0.4.0: small windows", () => {
  ui("right-click a tab to open it in a small window; the main tab fades and returns", { seed: seed({ "": { 甲: "一", 乙: "二", 丙: "三" } }) }, async (h) => {
    const { p } = h;
    await control(p);
    await h.tabMenu("甲");
    await p.click('#ctx [data-act="mini-open"]');
    await until(() => mockCtl(p, "miniOpened"), [{ book: "", name: "甲", x: null, y: null }], "the page is opened in a small window");
    await until(() => p.locator("#tabs .tab.in-mini").count(), 1, "the tab is marked");
    assert.equal(await p.locator("#tabs .tab.in-mini .mini-badge").textContent(), "小窗");
    await until(h.activeTab, "乙", "the main window moves to the next page");
    assert.equal(await h.editor(), "二");
    // 点变淡的标签:把小窗叫到前面,主窗口不换页
    await h.tab("甲小窗").click();
    await until(() => mockCtl(p, "miniFocused"), ["甲"]);
    assert.equal(await h.activeTab(), "乙");
    await h.tabMenu("甲小窗");
    assert.deepEqual(await p.$$eval("#ctx button", (bs) => bs.filter((b) => b.disabled).map((b) => b.dataset.act)), ["rename", "move", "delete"],
      "rename, move and delete wait until the page is back");
    await p.click('#ctx [data-act="mini-back"]');
    assert.deepEqual(await mockCtl(p, "miniRecalled"), ["甲"]);
    // 小窗里改过内容,然后放回主窗口
    await p.evaluate(() => (window.__mockBooks[""].files["甲"] = "小窗里改过"));
    await p.evaluate(() => window.__mockMiniClosed("", "甲", true));
    await until(h.activeTab, "甲", "放回 activates the page");
    await until(h.editor, "小窗里改过", "the main window shows what the small window saved");
    assert.equal(await p.locator("#tabs .tab.in-mini").count(), 0);
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("Control+End");
    await p.keyboard.type("!");
    await until(() => h.mockFile("", "甲"), "小窗里改过!", "editing works again without a conflict copy");
    assert.deepEqual(await h.tabs(), ["甲", "乙", "丙"]);
  });

  ui("a page in a small window is read only in the main window and never saved there", { seed: seed({ "": { 唯一: "原文" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => window.__mockEmit("mini-changed", [{ book: "", name: "唯一" }]));
    await p.locator("#read-error.in-mini").waitFor();
    assert.match(await p.textContent("#read-error"), /正在小窗里编辑/);
    assert.equal(await p.evaluate(() => document.querySelector("#editor .ProseMirror").contentEditable), "false");
    await control(p);
    await p.click("#read-error");
    assert.deepEqual(await mockCtl(p, "miniFocused"), ["唯一"], "the banner brings the small window forward");
    await p.keyboard.press("Control+w");
    await until(h.toast, "「唯一」正在小窗里编辑,先把它放回主窗口再删除");
    await p.evaluate(() => window.__minipad.flush());
    assert.equal(await h.mockFile("", "唯一"), "原文");
    assert.ok(!(await mockCtl(p, "calls")).includes("save_note"));
  });

  ui("the ↗ on a hovered tab, dragging a tab out and Shift+Enter in quick switch all open a small window", { seed: seed({ "": { 甲: "一", 乙: "二", 丙: "三" } }) }, async (h) => {
    const { p } = h;
    await control(p);
    assert.equal(await h.tab("乙").locator(".tab-mini").isVisible(), false, "hidden until hovered");
    const before = await h.tab("乙").evaluate((t) => t.getBoundingClientRect().width);
    await h.tab("乙").hover();
    await h.tab("乙").locator(".tab-mini").waitFor();
    const [nameRight, buttonLeft] = await h.tab("乙").evaluate((t) =>
      [t.querySelector("span").getBoundingClientRect().right, t.querySelector(".tab-mini").getBoundingClientRect().left]);
    assert.ok(buttonLeft >= nameRight, "the ↗ sits beside the name, never over it");
    assert.equal(await h.tab("乙").evaluate((t) => t.getBoundingClientRect().width), before, "the tab keeps its width, so nothing shifts");
    await h.tab("乙").locator(".tab-mini").click();
    await until(() => mockCtl(p, "miniOpened").then((o) => o?.map((m) => m.name)), ["乙"]);
    assert.equal(await h.activeTab(), "甲", "clicking ↗ does not switch pages");
    // 拖到窗口外面松手
    await h.tab("丙").evaluate((t) => {
      t.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }));
      const dt = new DataTransfer();
      dt.dropEffect = "none";
      t.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt, screenX: window.screenX + window.outerWidth + 80, screenY: window.screenY + 50 }));
    });
    await until(() => mockCtl(p, "miniOpened").then((o) => o?.map((m) => m.name)), ["乙", "丙"]);
    const dropped = (await mockCtl(p, "miniOpened"))[1];
    assert.ok(dropped.x > 440 && dropped.y > 0, "the small window opens where the tab was released");
    await p.keyboard.press("Control+p");
    await p.keyboard.type("甲");
    await p.keyboard.press("Shift+Enter");
    await until(() => mockCtl(p, "miniOpened").then((o) => o?.map((m) => m.name)), ["乙", "丙", "甲"]);
  });

  ui("settings turn small windows off, hide the ↗ and keep the other options", { seed: seed({ "": { 甲: "一", 乙: "二" } }) }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "window");
    assert.equal(await p.isChecked("#set-mini"), true);
    assert.equal(await p.isChecked("#set-mini-top"), true);
    assert.equal(await p.inputValue("#set-mini-hotkey"), "follow");
    assert.equal(await p.inputValue("#set-mini-max"), "");
    await p.selectOption("#set-mini-hotkey", "independent");
    await p.fill("#set-mini-max", "3");
    await p.locator("#set-mini-opacity").fill("70");
    await p.uncheck("#set-mini-tab-button");
    await p.uncheck("#set-mini-restore");
    await p.uncheck("#set-mini");
    assert.equal(await p.isDisabled("#set-mini-max"), true, "the other options grey out");
    await p.click("#set-save");
    const s = (await h.stored()).settings;
    assert.deepEqual([s.mini_enabled, s.mini_hotkey, s.mini_max, s.mini_opacity, s.mini_tab_button, s.mini_restore],
      [false, "independent", 3, 70, false, false]);
    assert.equal(await p.locator("#tabs .tab-mini").count(), 0);
    await h.tabMenu("乙");
    assert.equal(await p.locator('#ctx [data-act="mini-open"]').count(), 0);
    await p.keyboard.press("Escape");
    await control(p);
    await p.keyboard.press("Control+p");
    await p.keyboard.type("乙");
    await p.keyboard.press("Shift+Enter");
    await until(h.toast, "小窗已经关掉了,可以在 设置 → 窗口 里打开");
    assert.equal(await mockCtl(p, "miniOpened"), null);
  });

  ui("quitting waits for small windows to save and says when one could not", { seed: seed({ "": { 页: "一" } }) }, async (h) => {
    const { p } = h;
    await control(p, { miniFlushErrors: ["小窗「页」:磁盘满了"] });
    await p.evaluate(() => window.__mockEmit("before-quit", 21));
    await p.locator("#dialog").waitFor();
    assert.match(await p.textContent("#dialog-msg"), /小窗里的页面没保存成功.*磁盘满了/);
    await p.click("#dialog-cancel");
    assert.ok((await mockCtl(p, "calls")).includes("mini_flush_all"));
    assert.ok(!(await mockCtl(p, "calls")).includes("quit_app"));
    await control(p);
    await p.evaluate(() => window.__mockEmit("before-quit", 22));
    await until(async () => (await mockCtl(p, "calls")).includes("quit_app"), true, "quits once every small window saved");
  });

  ui("changing the notes folder waits until small windows are closed", { seed: seed({ "": { 甲: "一", 乙: "二" } }) }, async (h) => {
    const { p } = h;
    await p.evaluate(() => window.__mockEmit("mini-changed", [{ book: "", name: "甲" }]));
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await p.fill("#set-dir", "D:\\新笔记");
    await p.click("#set-save");
    await until(() => p.textContent("#set-error"), "还有页面在小窗里编辑,先把小窗都关掉再换笔记文件夹");
    assert.equal((await h.stored()).settings.notes_dir, "");
  });

  ui("the small window shows one page with its full title and the small-window buttons", {
    seed: seed({ "": { 甲: "一", "一个很长很长很长很长很长很长很长很长很长很长很长的页面名字": "长页面的内容" } }),
    url: miniUrl("", "一个很长很长很长很长很长很长很长很长很长很长很长的页面名字"),
  }, async (h) => {
    const { p } = h;
    await until(h.editor, "长页面的内容");
    assert.equal(await p.evaluate(() => document.documentElement.hasAttribute("data-mini")), true);
    const title = p.locator("#mini-title");
    assert.equal(await title.textContent(), "一个很长很长很长很长很长很长很长很长很长很长很长的页面名字");
    const [sw, cw, sh, ch] = await title.evaluate((t) => [t.scrollWidth, t.clientWidth, t.scrollHeight, t.clientHeight]);
    assert.ok(sw <= cw && sh <= ch, "the title wraps instead of being cut");
    for (const sel of ["#tabs", "#btn-book", "#btn-new", "#btn-settings", "#btn-search", "#btn-hide"]) {
      assert.equal(await p.isVisible(sel), false, `${sel} is hidden in a small window`);
    }
    for (const sel of ["#btn-mini-top", "#btn-mini-opacity", "#btn-mini-back", "#btn-mini-close", "#btn-format", "#format-bar"]) {
      assert.equal(await p.isVisible(sel), true, `${sel} is shown`);
    }
    // 只有这一页:Ctrl+T、Ctrl+W、Ctrl+Tab 都不做什么,Esc 不隐藏
    await control(p);
    await p.click("#editor .ProseMirror");
    for (const key of ["Control+t", "Control+w", "Control+Tab", "Escape"]) await p.keyboard.press(key);
    await p.keyboard.press("Control+End");
    await p.keyboard.type("!");
    await until(() => h.mockFile("", "一个很长很长很长很长很长很长很长很长很长很长很长的页面名字"), "长页面的内容!", "typing is saved");
    await p.evaluate(() => window.__minipad.flush());
    const calls = await mockCtl(p, "calls");
    for (const cmd of ["save_meta", "set_current_book", "create_note", "delete_note", "hide_window"]) {
      assert.ok(!calls.includes(cmd), `a small window never calls ${cmd}`);
    }
    assert.deepEqual((await h.mock())[""].meta.order, ["甲", "一个很长很长很长很长很长很长很长很长很长很长很长的页面名字"], "the notebook's order is untouched");
  });

  ui("small window buttons: on top, opacity, put back and close, and saving before quitting", {
    seed: seed({ "": { 甲: "一", 乙: "二" } }),
    url: miniUrl("", "乙"),
  }, async (h) => {
    const { p } = h;
    await until(h.editor, "二");
    await control(p);
    assert.equal(await p.getAttribute("#btn-mini-top", "aria-pressed"), "true", "on top by default");
    await p.click("#btn-mini-top");
    assert.equal(await p.getAttribute("#btn-mini-top", "aria-pressed"), "false");
    await p.click("#btn-mini-opacity");
    await p.locator("#mini-opacity").fill("60");
    await until(() => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--mini-opacity").trim()), "0.6");
    assert.deepEqual(await mockCtl(p, "miniSet"), [{ top: false, opacity: null }, { top: null, opacity: 60 }]);
    assert.equal(await p.textContent("#mini-opacity-val"), "60%");
    // 退出程序前存好
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("Control+End");
    await p.keyboard.type("!");
    await p.evaluate(() => window.__mockEmit("mini-flush"));
    await until(() => mockCtl(p, "miniFlushed"), [null]);
    assert.equal(await h.mockFile("", "乙"), "二!");
    // 设置在主窗口里改了:小窗跟着换
    await p.evaluate(() => window.__mockEmit("settings-changed", { ...window.__minipad.state.settings, font_size: 20 }));
    await until(() => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size").trim()), "20px");
    await p.click("#btn-mini-back");
    await until(() => mockCtl(p, "miniClosed"), [true], "放回主窗口");
    await p.click("#btn-mini-close");
    await until(() => mockCtl(p, "miniClosed"), [true, false], "关闭");
    await p.evaluate(() => window.__mockEmit("mini-close-request"));
    await until(() => mockCtl(p, "miniClosed"), [true, false, false], "Alt+F4 also saves first");
  });
});

describe("0.4.0: images", () => {
  ui("a pasted screenshot is saved in assets and shown; the page keeps a relative link", { seed: seed({ "": { 页: "文字" } }) }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror");
    await p.keyboard.press("Control+End");
    await sendImage(p, "paste");
    await until(() => h.mockFile("", "页"), "文字![](assets/img-20261016-101500.png)", "the page links the saved image");
    const img = p.locator("#editor .ProseMirror img:not(.ProseMirror-separator)");
    assert.match(await img.getAttribute("src"), /^data:image\/png;base64,/, "the image is shown");
    await until(() => img.evaluate((i) => i.naturalWidth), 1);
    await sendImage(p, "drop", "图表.png");
    await until(() => h.mockFile("", "页").then((t) => t.match(/!\[[^\]]*\]\([^)]+\)/g)?.sort()),
      ["![](assets/img-20261016-101500.png)", "![图表](assets/img-20261016-101500-2.png)"], "a dropped file gets its own name");
  });

  ui("images can be turned off and resized in settings, and move with their page", {
    seed: seed({ "": { 页: "文字" }, 别处: { 旧: "x" } }),
  }, async (h) => {
    const { p } = h;
    await p.click("#editor .ProseMirror");
    await sendImage(p, "paste");
    await until(() => h.mockFile("", "页").then((t) => t.includes("assets/img-")), true);
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.isChecked("#set-image-paste"), true);
    await p.selectOption("#set-image-size", "small");
    await p.uncheck("#set-image-paste");
    await p.click("#set-save");
    assert.equal(await p.evaluate(() => document.documentElement.dataset.imageSize), "small");
    assert.ok((await p.locator("#editor .ProseMirror img:not(.ProseMirror-separator)").evaluate((i) => i.getBoundingClientRect().width)) <= 240);
    const before = await h.mockFile("", "页");
    await control(p);
    await p.click("#editor .ProseMirror");
    await sendImage(p, "paste");
    await p.evaluate(() => window.__minipad.flush());
    assert.ok(!(await mockCtl(p, "calls")).includes("save_image"), "turned off: nothing is saved");
    assert.equal(await h.mockFile("", "页"), before);
    await h.tabMenu("页");
    await p.click('#ctx [data-act="move"]');
    await h.item("别处").click();
    await until(() => p.evaluate(() => window.__mockImage("别处", "assets/img-20261016-101500.png").slice(0, 11)), "data:image/",
      "the image is copied to the other notebook");
  });
});

// ---------- 0.4.2:Prompt 上色、高亮配色、语言列表 ----------
const PROMPT_PAGE = [
  "```prompt 提示词",
  "# 角色",
  "System: 你是一位{{领域}}专家。",
  "<rules>",
  "- **必须**用中文回答",
  "- 不超过 {字数} 字",
  "</rules>",
  "<!-- 备注 -->",
  "```",
].join("\n");

describe("0.4.2: code highlighting", () => {
  ui("prompt blocks color tags, variables, roles, headings and emphasis", {
    seed: seed({ "": { 页: PROMPT_PAGE } }),
  }, async (h) => {
    const { p } = h;
    const code = p.locator("#editor .codeblock code");
    const spans = (cls) => code.locator(`.hljs-${cls}`).allTextContents();
    await until(() => spans("section"), ["# 角色"], "headings");
    assert.deepEqual(await spans("type"), ["System"], "roles");
    assert.deepEqual(await spans("template-variable"), ["{{领域}}", "{字数}"], "variables");
    assert.deepEqual(await spans("name"), ["rules", "rules"], "tag names");
    assert.deepEqual(await spans("keyword"), ["必须"], "emphasis words");
    assert.equal((await spans("comment")).join(""), "<!-- 备注 -->", "comments");
    assert.equal(await h.editor(), PROMPT_PAGE, "coloring never changes the text");
  });

  ui("unlabelled code is never guessed as a prompt", {
    seed: seed({ "": { 页: "```\nSystem: hi {{x}}\n```" } }),
  }, async (h) => {
    await h.p.locator("#editor .codeblock").waitFor();
    assert.equal(await h.p.locator("#editor .codeblock .hljs-template-variable").count(), 0);
  });

  ui("each code block picks its own highlight theme from a dropdown in its header", {
    seed: seed({ "": { 页: "```js\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```" } }),
  }, async (h) => {
    const { p } = h;
    const blocks = p.locator("#editor .codeblock");
    const keyword = (i) => blocks.nth(i).locator(".hljs-keyword").first().evaluate((el) => getComputedStyle(el).color);
    await until(() => keyword(0), "rgb(166, 38, 164)", "the default theme");
    assert.equal(await p.locator("#set-code-theme").count(), 0, "no theme option in settings");
    await blocks.first().hover();
    await blocks.first().locator(".cb-theme").click();
    const menu = p.locator(".cb-theme-menu");
    await menu.waitFor();
    assert.deepEqual(await menu.locator("button").allTextContents(),
      ["默认", "GitHub", "Dracula", "Nord", "Solarized", "Monokai", "梦幻", "星空", "彩虹"]);
    assert.equal(await menu.locator("button.on").getAttribute("data-theme"), "", "the current theme is marked");
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/theme-menu.png` });
    await menu.locator('button[data-theme="dracula"]').click();
    await until(() => keyword(0), "rgb(163, 20, 77)", "the first block switches");
    assert.equal(await keyword(1), "rgb(166, 38, 164)", "the second block keeps its own theme");
    assert.ok(await menu.isHidden());
    await until(h.editor, "```js [minipad-theme dracula]\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```",
      "the theme is kept on the fence line");
    await p.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await until(() => keyword(0), "rgb(255, 121, 198)", "each theme has a dark variant");
    await p.evaluate(() => window.__minipad.flush());
    await p.reload();
    await blocks.first().waitFor();
    assert.equal(await blocks.first().getAttribute("data-code-theme"), "dracula", "remembered after restart");
    await blocks.first().hover();
    await blocks.first().locator(".cb-theme").click();
    await p.locator('.cb-theme-menu button[data-theme=""]').click();
    await until(h.editor, "```js\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```", "back to the default removes the marker");
  });

  ui("theme, title, colors and folding read back together", {
    seed: seed({ "": { 页: "```prompt 标题 [minipad-theme starry] [minipad-colors c0-2=#e5484d] [minipad-folded]\nabc\n```" } }),
  }, async (h) => {
    const { p } = h;
    const block = p.locator("#editor .codeblock");
    await block.waitFor();
    assert.equal(await block.getAttribute("data-code-theme"), "starry");
    assert.equal(await block.locator(".cb-title").inputValue(), "标题");
    assert.equal(await block.locator(".cb-lang").inputValue(), "prompt");
    assert.ok(await block.locator("pre").isHidden());
    assert.equal(await h.editor(), "```prompt 标题 [minipad-theme starry] [minipad-colors c0-2=#e5484d] [minipad-folded]\nabc\n```");
  });

  ui("the language box lists common languages and still accepts typing", {
    seed: seed({ "": { 页: "```\nprint(1)\n```" } }),
  }, async (h) => {
    const { p } = h;
    const lang = p.locator("#editor .cb-lang");
    const menu = p.locator(".cb-lang-menu");
    await lang.click();
    await until(() => menu.isVisible(), true, "focusing the box opens the list");
    assert.equal(await menu.locator("button").first().getAttribute("data-lang"), "prompt", "Prompt comes first");
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/lang-menu.png` });
    await p.keyboard.type("pyt");
    assert.deepEqual(await menu.locator("button").evaluateAll((bs) => bs.map((b) => b.dataset.lang)), ["python"],
      "typing filters the list");
    await p.keyboard.press("Enter");
    await until(h.editor, "```python\nprint(1)\n```", "Enter picks the highlighted language");
    assert.ok(await menu.isHidden());
    await lang.click();
    await menu.locator('button[data-lang="prompt"]').click();
    await until(h.editor, "```prompt\nprint(1)\n```", "clicking picks a language");
    await lang.click();
    await p.keyboard.press("Control+a");
    await p.keyboard.type("brainfuck");
    assert.ok(await menu.isHidden(), "no match hides the list");
    await p.keyboard.press("Enter");
    await until(h.editor, "```brainfuck\nprint(1)\n```", "languages outside the list can still be typed");
  });

  ui("the language list can be turned off", {
    seed: { ...seed({ "": { 页: "```\nx\n```" } }), settings: { ...SETTINGS, code_lang_menu: false } },
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .cb-lang").click();
    await sleep(150);
    assert.equal(await p.locator(".cb-lang-menu:visible").count(), 0);
  });
});

describe("0.4.2: colors inside code blocks", () => {
  const fbBtn = (cmd) => `#format-bar [data-cmd="${cmd}"]`;
  const line = "System: 你是一位{{领域}}专家";

  ui("text in a code block can be colored like normal text and the code stays plain", {
    seed: { ...seed({ "": { 页: "```prompt\n" + line + "\n```" } }), settings: { ...SETTINGS, format_bar: true } },
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .codeblock .hljs-template-variable").waitFor();
    await p.click("#editor .codeblock code");
    await p.keyboard.press("End");
    await p.keyboard.press("Shift+Home");
    await until(h.selection, line);
    assert.equal(await p.locator(fbBtn("strong")).isDisabled(), true, "bold stays off in code");
    await p.click(fbBtn("color"));
    await expandLibrary(p, ".fb-pop");
    await p.click('.fb-pop .uc-swatch[data-color="#3b82f6"]');
    const saved = "```prompt [minipad-colors c0-" + line.length + "=#3b82f6]\n" + line + "\n```";
    await until(h.editor, saved, "the color goes on the fence line, the code itself is untouched");
    assert.equal(await p.locator("#editor .codeblock .hljs-template-variable").evaluate((el) => getComputedStyle(el).color),
      "rgb(59, 130, 246)", "the chosen color wins over the highlight");
    await until(() => h.mockFile("", "页"), saved, "saved");
    await p.reload();
    await p.locator('#editor .codeblock span[data-color="#3b82f6"]').waitFor();
    assert.equal(await p.locator("#editor .codeblock code").textContent(), line, "after restart the code is the same");
    assert.equal(await p.locator("#editor .cb-lang").inputValue(), "prompt", "the marker is not taken as the language");
  });

  ui("gradients, backgrounds, titles and folding all fit on the fence line", {
    seed: seed({ "": { 页: "```prompt 一行提示 [minipad-colors c0-6=linear-gradient(90deg, #ff5f6d, #4dabf7);b10-12=#fbe9a6] [minipad-folded]\n" + line + "\n```" } }),
  }, async (h) => {
    const { p } = h;
    const block = p.locator("#editor .codeblock");
    await block.waitFor();
    assert.ok(await block.locator("pre").isHidden(), "still collapsed");
    assert.equal(await block.locator(".cb-title").inputValue(), "一行提示");
    assert.equal(await block.locator(".cb-lang").inputValue(), "prompt");
    assert.equal(await block.locator('span[data-color^="linear-gradient"]').textContent(), "System");
    assert.equal(await block.locator("span[data-bg]").textContent(), "一位");
    await block.locator(".cb-toggle").click();
    await p.evaluate(() => window.__minipad.flush());
    assert.equal(await h.mockFile("", "页"),
      "```prompt 一行提示 [minipad-colors c0-6=linear-gradient(90deg, #ff5f6d, #4dabf7);b10-12=#fbe9a6]\n" + line + "\n```",
      "expanding keeps the colors and drops only the fold marker");
  });

  ui("a code block with only colors and no language or title reads back the same", {
    seed: seed({ "": { 页: "```[minipad-colors c0-2=#e5484d]\nabc\n```" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator('#editor .codeblock span[data-color="#e5484d"]').waitFor();
    assert.equal(await p.locator("#editor .cb-lang").inputValue(), "");
    assert.equal(await p.locator("#editor .cb-title").inputValue(), "");
    assert.equal(await h.editor(), "```[minipad-colors c0-2=#e5484d]\nabc\n```");
  });
});

describe("0.4.3: code block title colors", () => {
  const pick = async (h, i) => {
    const block = h.p.locator("#editor .codeblock").first();
    await block.hover();
    await block.locator(".cb-title-color").click();
    const menu = h.p.locator(".cb-title-color-menu");
    await menu.waitFor();
    return menu;
  };

  ui("a code block title takes a solid, gradient or material color from the swatch next to it", {
    seed: seed({ "": { 页: "```js 示例\nconst a = 1;\n```" } }),
  }, async (h) => {
    const { p } = h;
    const title = p.locator("#editor .cb-title");
    let menu = await pick(h);
    assert.deepEqual(await menu.locator(".uc-kind").allTextContents(), ["纯色", "渐变", "材质"], "the shared color library");
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/title-color-menu.png` });
    const solid = await menu.locator(".uc-swatch").first().getAttribute("data-color");
    await menu.locator(".uc-swatch").first().click();
    assert.ok(await menu.isHidden(), "the menu closes after picking");
    await until(h.editor, "```js 示例 [minipad-title-color " + solid + "]\nconst a = 1;\n```", "kept on the fence line");
    assert.match(await title.getAttribute("style"), /color:/, "the title shows the color");

    menu = await pick(h);
    await menu.locator('.uc-kind[data-kind="gradient"]').click();
    const gradient = await menu.locator(".uc-swatch").first().getAttribute("data-color");
    await menu.locator(".uc-swatch").first().click();
    await until(h.editor, "```js 示例 [minipad-title-color " + gradient + "]\nconst a = 1;\n```", "gradients too");
    assert.match(await title.getAttribute("style"), /background-clip: text/);
    await p.evaluate(() => window.__minipad.flush());
    await p.reload();
    await title.waitFor();
    assert.match(await title.getAttribute("style"), /background-clip: text/, "remembered after restart");

    menu = await pick(h);
    await menu.locator(".fb-none").click();
    await until(h.editor, "```js 示例\nconst a = 1;\n```", "默认颜色 removes the marker");
    assert.doesNotMatch((await title.getAttribute("style")) || "", /color:/);
  });

  ui("title color, theme, text colors and folding read back together", {
    seed: seed({ "": { 页: "```prompt 标题 [minipad-theme starry] [minipad-title-color #e5484d] [minipad-colors c0-2=#3b82f6] [minipad-folded]\nabc\n```" } }),
  }, async (h) => {
    const { p } = h;
    const block = p.locator("#editor .codeblock");
    await block.waitFor();
    assert.equal(await block.locator(".cb-title").inputValue(), "标题");
    assert.match(await block.locator(".cb-title").getAttribute("style"), /color: rgb\(229, 72, 77\)|color: #e5484d/);
    assert.equal(await block.getAttribute("data-code-theme"), "starry");
    assert.ok(await block.evaluate((el) => el.classList.contains("folded")));
    await block.locator(".cb-title").click();
    await p.keyboard.press("End");
    await p.keyboard.type("2");
    await p.keyboard.press("Enter");
    await until(h.editor, "```prompt 标题2 [minipad-theme starry] [minipad-title-color #e5484d] [minipad-colors c0-2=#3b82f6] [minipad-folded]\nabc\n```",
      "editing the title keeps every marker");
  });

  ui("no title, no swatch; clearing the title drops its color", {
    seed: seed({ "": { 页: "```js\nx\n```\n\n```js 有标题 [minipad-title-color #e5484d]\ny\n```" } }),
  }, async (h) => {
    const { p } = h;
    const blocks = p.locator("#editor .codeblock");
    await blocks.first().hover();
    assert.ok(await blocks.first().locator(".cb-title-color").isHidden(), "nothing to color without a title");
    const title = blocks.nth(1).locator(".cb-title");
    await title.fill("");
    await title.press("Enter");
    await until(h.editor, "```js\nx\n```\n\n```js\ny\n```", "the color goes with the title");
  });

  ui("the swatch can be turned off in settings", {
    seed: { ...seed({ "": { 页: "```js 示例 [minipad-title-color #e5484d]\nx\n```" } }), settings: { ...SETTINGS, code_title_color: false } },
  }, async (h) => {
    const { p } = h;
    const block = p.locator("#editor .codeblock");
    await block.hover();
    assert.ok(await block.locator(".cb-title-color").isHidden(), "no swatch");
    assert.match(await block.locator(".cb-title").getAttribute("style"), /color:/, "existing colors still show");
    await p.click("#btn-settings");
    await p.click('#set-nav [data-page="edit"]');
    assert.equal(await p.locator("#set-code-title-color").isChecked(), false);
    await p.check("#set-code-title-color");
    await p.click("#set-save");
    await block.hover();
    await block.locator(".cb-title-color").waitFor();
  });
});

describe("0.4.3: prompt tag attributes", () => {
  ui("attribute values inside prompt tags take the string color, not the tag color", {
    seed: seed({ "": { 页: '```prompt\n<example type="good">x</example>\n```' } }),
  }, async (h) => {
    const code = h.p.locator("#editor .codeblock code");
    const value = code.locator(".hljs-string", { hasText: "good" });
    await value.waitFor();
    const color = (loc) => loc.evaluate((el) => getComputedStyle(el).color);
    const string = await h.p.evaluate(() => getComputedStyle(document.querySelector("#editor .codeblock")).getPropertyValue("--hl-string").trim());
    assert.deepEqual(await code.locator(".hljs-name").allTextContents(), ["example", "example"], "tag names");
    assert.deepEqual(await code.locator(".hljs-attr").allTextContents(), ["type"], "attribute names");
    assert.notEqual(await color(value), await color(code.locator(".hljs-name").first()), "differs from the tag name");
    assert.equal(await value.evaluate((el, c) => { const probe = document.createElement("span"); probe.style.color = c; document.body.append(probe); const v = getComputedStyle(probe).color; probe.remove(); return v === getComputedStyle(el).color; }, string), true, "uses --hl-string");
  });
});

describe("0.4.3: new version notice", () => {
  const LATEST = "https://api.github.com/repos/AlstarKnight/minipad-next/releases/latest";
  const reply = (tag, hits = []) => (route) => {
    hits.push(route.request().url());
    return route.fulfill({ json: { tag_name: tag, html_url: `https://github.com/AlstarKnight/minipad-next/releases/tag/${tag}` } });
  };

  const newer = [];
  ui("a newer release shows in the status bar and opens its page", {
    mockControl: { version: "0.4.3" },
    routes: { [LATEST]: reply("v0.5.0", newer) },
  }, async (h) => {
    const { p } = h;
    const notice = p.locator("#st-update");
    await notice.waitFor();
    assert.equal(await notice.textContent(), "新版本 0.5.0");
    assert.equal(newer.length, 1, "checked once at startup");
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/update-notice.png` });
    await p.evaluate(() => {
      window.__opened = [];
      window.open = (url) => window.__opened.push(url);
    });
    await notice.click();
    await until(() => p.evaluate(() => window.__opened), ["https://github.com/AlstarKnight/minipad-next/releases/tag/v0.5.0"], "opens the release page");
    // 关掉以后提示也收起来
    await p.click("#btn-settings");
    assert.equal(await p.locator("#set-update-check").isChecked(), true, "on by default");
    await p.uncheck("#set-update-check");
    await p.click("#set-save");
    await until(() => notice.isHidden(), true, "hidden when turned off");
  });

  const same = [];
  ui("nothing shows when this is the latest version", {
    mockControl: { version: "0.4.3" },
    routes: { [LATEST]: reply("v0.4.3", same) },
  }, async (h) => {
    await until(() => same.length, 1, "checked");
    await h.p.waitForTimeout(200);
    assert.ok(await h.p.locator("#st-update").isHidden());
  });

  const off = [];
  ui("turned off: GitHub is never asked", {
    mockControl: { version: "0.4.3" },
    seed: { ...seed({ "": { 页: "x" } }), settings: { ...SETTINGS, update_check: false } },
    routes: { [LATEST]: reply("v0.5.0", off) },
  }, async (h) => {
    await h.p.waitForTimeout(300);
    assert.equal(off.length, 0);
    assert.ok(await h.p.locator("#st-update").isHidden());
  });
});

describe("0.4.4: interface styles", () => {
  const styled = (ui, extra = {}) => ({
    ...seed({ "": { 甲: "一", 乙: "二" }, 工作: { 周报: "三" } }),
    settings: { ...SETTINGS, ui_style: ui, ...extra },
  });
  const root = (p, name) => p.evaluate((n) => document.documentElement.getAttribute(n), name);

  ui("a fresh install uses the starry style with the notebook rail; the rail switches and adds notebooks", async (h) => {
    const { p } = h;
    assert.equal(await root(p, "data-ui"), "starry");
    assert.equal(await root(p, "data-side"), "rail");
    assert.deepEqual(await p.$$eval("#side .side-rail-book", (bs) => bs.map((b) => b.textContent)), ["默认"]);
    await p.click("#side .side-add");
    await h.answer("工作");
    await until(h.bookName, "工作", "the new notebook is opened");
    assert.deepEqual(await p.$$eval("#side .side-rail-book", (bs) => bs.map((b) => [b.textContent, b.classList.contains("current")])), [["默认", false], ["工作", true]]);
    await p.locator("#side .side-rail-book").filter({ hasText: "默认" }).click();
    await until(h.bookName, "默认", "a rail click switches the notebook");
    // 窗口太窄时不显示侧栏
    await p.setViewportSize({ width: 380, height: 540 });
    await until(() => root(p, "data-side"), null, "too narrow: no rail");
    assert.ok(await p.locator("#side").isHidden());
  });

  ui("paper: the outline tree lists notebooks and pages, opens pages, and the notebook button folds it", { seed: styled("paper") }, async (h) => {
    const { p } = h;
    await p.setViewportSize({ width: 900, height: 600 });
    await until(() => root(p, "data-side"), "tree", "the tree shows in a wide window");
    const rows = () => p.$$eval("#side .side-list > :is(.side-book, .side-page)", (bs) => bs.map((b) => b.className.replace("side-", "") + ":" + b.textContent));
    assert.deepEqual(await rows(), ["book current:默认", "page current:甲", "page:乙", "book:工作"]);
    await p.locator("#side .side-page").filter({ hasText: "乙" }).click();
    await until(h.activeTab, "乙", "a page click opens it");
    await p.locator("#side .side-book").filter({ hasText: "工作" }).click();
    await until(h.bookName, "工作", "another notebook is opened");
    await until(rows, ["book:默认", "book current:工作", "page current:周报"], "the current notebook unfolds");
    const left = () => p.$eval("#main", (m) => Math.round(m.getBoundingClientRect().left));
    const open = await left();
    await p.click("#btn-book");
    await until(() => root(p, "data-side"), null, "the notebook button folds the tree");
    assert.equal(open - (await left()), 208, "the page made room for the tree");
    assert.ok(await p.locator("#books").isHidden(), "and does not open the list");
    await p.click("#btn-book");
    await until(() => root(p, "data-side"), "tree", "and unfolds it again");
    // 改名、删除这些还在原来的笔记本列表里
    await p.click("#side .side-more");
    await p.locator("#books").waitFor();
    assert.equal((await h.items()).length, 2);
  });

  ui("settings: style cards show only their own options, save at once, and turning a sidebar off brings back the list", { seed: styled("starry") }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    const checked = () => p.$$eval("#set-ui-style [aria-checked=true]", (bs) => bs.map((b) => b.dataset.ui));
    const visible = () => p.$$eval("[data-ui-only]", (rows) => rows.filter((r) => !r.hidden).map((r) => r.querySelector("input").id));
    assert.deepEqual(await checked(), ["starry"]);
    assert.deepEqual(await visible(), ["set-ui-rail", "set-ui-stars"]);
    await p.click('#set-ui-style [data-ui="paper"]');
    assert.deepEqual(await checked(), ["paper"]);
    assert.deepEqual(await visible(), ["set-ui-tree"]);
    await p.click('#set-ui-style [data-ui="material"]');
    assert.deepEqual(await visible(), []);
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.ui_style, "material", "saved");
    assert.equal(await root(p, "data-ui"), "material");
    assert.equal(await root(p, "data-side"), null, "material has no sidebar");
    // 星空渐变关掉笔记本侧栏
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.click('#set-ui-style [data-ui="starry"]');
    await p.uncheck("#set-ui-rail");
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.ui_rail, false, "the rail switch is saved");
    assert.equal(await root(p, "data-ui"), "starry");
    assert.equal(await root(p, "data-side"), null);
    await h.openBooks();
    assert.equal((await h.items()).length, 2, "the notebook button opens the list as before");
    // 经典:不加 data-ui,回到原来的样子
    await h.closeBooks();
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.click('#set-ui-style [data-ui="classic"]');
    await p.click("#set-save");
    await until(() => root(p, "data-ui"), null, "classic has no style attribute");
    assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()), "#d9822b", "the old orange");
  });

  ui("the accent follows the style unless one was picked, and a picked accent survives a style change", { seed: styled("paper", { accent: "#16a34a" }) }, async (h) => {
    const { p } = h;
    const accent = () => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    assert.equal(await accent(), "#16a34a", "an existing accent is kept");
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.click('#set-ui-style [data-ui="starry"]');
    await p.click("#set-save");
    await until(() => root(p, "data-ui"), "starry");
    assert.equal(await accent(), "#16a34a", "still the picked accent");
    // 选回「跟随风格」(第一个色块)
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.click('#set-accent button[data-color=""]');
    await p.click("#set-save");
    await until(async () => (await h.stored())?.settings?.accent, "", "follow the style is saved");
    assert.equal(await accent(), "#5b47d6", "the starry accent");
    await p.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    assert.equal(await accent(), "#b3a6ff", "and its dark variant");
  });

  ui("starry dark: the stars switch follows the setting", { seed: styled("starry", { theme: "dark" }) }, async (h) => {
    const { p } = h;
    const stars = () => p.$eval("#bar", (b) => getComputedStyle(b).backgroundImage);
    assert.match(await stars(), /radial-gradient/);
    await p.click("#btn-settings");
    await settingsPage(p, "look");
    await p.uncheck("#set-ui-stars");
    await p.click("#set-save");
    await until(stars, "none", "no stars");
    assert.equal(await root(p, "data-stars"), null);
  });

  ui("small windows have no sidebar", { seed: styled("starry"), url: miniUrl("", "甲") }, async (h) => {
    const { p } = h;
    await p.waitForTimeout(300);
    assert.equal(await root(p, "data-ui"), "starry", "the small window follows the style");
    assert.equal(await root(p, "data-side"), null);
    assert.ok(await p.locator("#side").isHidden());
  });
});

suite("0.4.5: WebDAV settings", { concurrency: 1 }, () => {
  ui("test connection uses form draft without persisting it", {
    seed: seed({ "": { "笔记": "内容" } }),
  }, async (h) => {
    const { p } = h;
    await p.click("#btn-settings");
    await settingsPage(p, "data");
    await p.fill("#set-webdav-server", "https://dav.example.com/");
    await p.fill("#set-webdav-user", "example");
    await p.click("#set-webdav-test");
    await until(h.toast, "连接成功，目录读取和写入测试通过（预览模拟）", "test connection succeeds");
    assert.equal((await h.stored()).settings.webdav_server || "", "", "testing did not save the draft");
  });
});

suite("0.4.5: local file paths", { concurrency: 1 }, () => {
  ui("local path missing state can be simulated", {
    seed: seed({ "": { "路径": "打开 C:\\docs\\note.pdf" } }),
  }, async ({ p }) => {
    await p.locator("#editor .local-file-path.missing").waitFor();
    assert.equal(await p.locator("#editor .local-file-path.missing").count(), 1);
  });


  ui("local file links are decorated and settings survive reopening", {
    seed: seed({ "": { "路径": "打开 C:\\docs\\note.pdf 并查看。" } }),
  }, async (h) => {
    const { p } = h;
    await p.locator("#editor .local-file-path").waitFor();
    assert.equal(await p.locator("#editor .local-file-path").first().getAttribute("data-local-path"), "C:\\docs\\note.pdf");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.locator("#set-local-path").isChecked(), true);
    await p.uncheck("#set-local-path");
    await p.selectOption("#set-local-path-click", "click");
    await p.click("#set-save");
    await until(() => p.locator("#editor .local-file-path").count(), 0, "path decoration is disabled");
    await p.click("#btn-settings");
    await settingsPage(p, "edit");
    assert.equal(await p.locator("#set-local-path").isChecked(), false);
    assert.equal(await p.locator("#set-local-path-click").inputValue(), "click");
  });

});
