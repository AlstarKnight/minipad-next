// 页面很多时的性能基准(0.4.7):浏览器预览(模拟后端)里放一个 5000 页的笔记本,
// 测电脑版三种布局和手机版的常用操作,打印一张表。
//   npm run bench               只看数字
//   npm run bench -- --check    有一项超过上限就失败(CI 里跑;表格同时写进这次运行的摘要页)
// 上限留了余量,机器忽快忽慢不会误报;退回到「换页整排重画」那种量级一定会被抓到。
// 真机(尤其是手机)比这里慢,这些数字用来前后对比,不代表真机上的绝对时间。
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const PAGES = 5000;
const BOOK = "万页";
const check = process.argv.includes("--check");

// 每页约 330 个汉字:标题、几段话、列表和任务,每 10 页一个代码块,每 97 页一个只出现一次的搜索词
const LINE = "今天整理了项目的进度和下一步计划，记录一下需要跟进的事情和遇到的问题。";
const pageName = (i) => `页面 ${String(i).padStart(4, "0")}`;
function pageText(i) {
  const parts = [`# 第 ${i} 页`, "", LINE.repeat(3), "", `- 待办 ${i}`, "- 已完成的事情", "- [ ] 任务", "", LINE.repeat(4)];
  if (i % 10 === 0) parts.push("", "```js", `console.log(${i});`, "```");
  if (i % 97 === 0) parts.push("", "唯一关键词" + i);
  return parts.join("\n");
}
const files = {};
for (let i = 1; i <= PAGES; i++) files[pageName(i)] = pageText(i);

// [名称, 说明, 上限(毫秒)]。换页的上限卡在优化前后之间(优化前 300–660 ms),其余几项只防严重退步
const DESKTOP = [
  ["startup", "启动到能编辑", 6000],
  ["switch", "Ctrl+Tab 换一页", 200],
  ["newPage", "新建页面", 1500],
  ["typing", "打字(每次输入)", 10],
  ["save", "保存一页", 150],
  ["linkFilter", "[[ 补全筛选(拼音)", 150],
  ["syncSame", "切回窗口(都没变)", 150],
  ["syncOne", "切回窗口(别处改了一页)", 150],
  ["search", "搜索全部页面", 200],
  ["quickOpen", "Ctrl+P 打开", 150],
  ["quickFilter", "Ctrl+P 筛选", 150],
];
const MOBILE = [
  ["startup", "启动到能编辑", 2000],
  ["switch", "在抽屉里点一页换过去", 250],
  ["openDrawer", "打开抽屉", 500],
  ["filter", "筛选页面", 150],
];

// 页面里用的小工具:做一件事,等条件成立(最多 10 秒),再等这一帧画出来,返回用了多少毫秒
const helpers = () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  window.__bench = {
    async time(fn, until = () => true) {
      const t = performance.now();
      await fn();
      while (!until()) {
        if (performance.now() - t > 10000) throw new Error("等太久了:" + until);
        await frame();
      }
      await frame();
      return performance.now() - t;
    },
    // 按键(Ctrl+P 这类可以改的快捷键看的是 code)
    key(key, mods = {}) {
      const code = key.length === 1 ? "Key" + key.toUpperCase() : key;
      document.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods }));
    },
    title: () => document.querySelector("#editor .ProseMirror h1")?.textContent || "",
  };
};

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
// 做 n 次取中间值,偶尔一次垃圾回收不影响结果
async function repeat(n, fn) {
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(await fn(i));
  return median(xs);
}
const round = (ms) => (ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms));

async function desktop(browser, base, settings) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  // 几千页放不进 localStorage,模拟后端直接用 __mockControl.books(见 mock.js)
  await ctx.addInitScript(([books, book, s]) => {
    window.__mockControl = { books, book };
    localStorage.setItem("minipad-next-demo", JSON.stringify({ settings: s }));
  }, [{ "": { files: { 欢迎: "# 欢迎" } }, [BOOK]: { files } }, BOOK, settings]);
  await ctx.addInitScript(helpers);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const out = {};
  try {
    const t0 = Date.now();
    await page.goto(base + "/index.html");
    await page.waitForFunction(() => window.__bench.title() === "第 1 页", null, { timeout: 30000 });
    out.startup = Date.now() - t0;
    // 鼠标停在编辑区,别悬停在标签上
    await page.mouse.move(450, 450);

    out.switch = await repeat(15, (i) => page.evaluate((title) =>
      __bench.time(() => __bench.key("Tab", { ctrlKey: true }), () => __bench.title() === title), `第 ${i + 2} 页`));

    out.newPage = await repeat(3, async () => {
      const ms = await page.evaluate(() => __bench.time(() => __bench.key("n", { ctrlKey: true }), () => document.querySelector("#tabs input")));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#tabs input"));
      return ms;
    });

    // 回到第一页的最后打字(按页面里的事务算,不算 Playwright 发按键的开销),再保存
    await page.keyboard.press("Control+1");
    await page.waitForFunction(() => __bench.title() === "第 1 页");
    await page.locator("#editor .ProseMirror").click();
    await page.keyboard.press("Control+End");
    const saves = [];
    out.typing = await repeat(3, async () => {
      const ms = await page.evaluate(async () => {
        const view = window.__minipad.editor().view;
        return (await __bench.time(() => { for (let i = 0; i < 50; i++) view.dispatch(view.state.tr.insertText("字")); })) / 50;
      });
      saves.push(await page.evaluate(() => __bench.time(() => window.__minipad.flush())));
      return ms;
    });
    out.save = median(saves);

    // 0.5.0 页面链接:打了 [[ 以后再打拼音和数字,列表筛到这一页
    out.linkFilter = await repeat(3, async () => {
      const ms = await page.evaluate(async () => {
        const view = window.__minipad.editor().view;
        view.dispatch(view.state.tr.insertText(" [["));
        await __bench.time(() => {}, () => document.querySelector(".page-link-menu:not([hidden])"));
        return __bench.time(() => view.dispatch(view.state.tr.insertText("ym 4321")),
          () => document.querySelectorAll(".page-link-menu:not([hidden]) button").length === 1);
      });
      await page.keyboard.press("Escape");
      return ms;
    });

    // 切回窗口时的重新读取;sync 正忙(返回 false)时过一会儿再来
    const sync = () => page.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        let done = false;
        const ms = await __bench.time(async () => (done = await window.__minipad.sync()));
        if (done) return ms;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("一直没能重新读取");
    });
    out.syncSame = await repeat(3, sync);
    out.syncOne = await repeat(3, async (i) => {
      await page.evaluate(([book, name]) => (window.__mockBooks[book].files[name] += "\n\n别处改的"), [BOOK, pageName(2500 + i * 1000)]);
      return sync();
    });

    // 全部搜索:先搜一次,之后打开搜索框时用留着的词马上搜
    await page.evaluate(async () => {
      __bench.key("F", { ctrlKey: true, shiftKey: true });
      const input = document.querySelector("#search-input");
      input.value = "唯一关键词";
      await __bench.time(() => input.dispatchEvent(new Event("input", { bubbles: true })), () => document.querySelector("#search-results").children.length);
    });
    await page.keyboard.press("Escape");
    out.search = await repeat(3, async () => {
      const ms = await page.evaluate(() => __bench.time(() => __bench.key("F", { ctrlKey: true, shiftKey: true }), () => document.querySelector("#search-results").children.length));
      await page.keyboard.press("Escape");
      return ms;
    });

    const filters = [];
    out.quickOpen = await repeat(3, async () => {
      const ms = await page.evaluate(() => __bench.time(() => __bench.key("p", { ctrlKey: true }), () => document.querySelector("#quick-input").offsetParent));
      filters.push(await page.evaluate(() => {
        const input = document.querySelector("#quick-input");
        input.value = "页面 4321";
        return __bench.time(() => input.dispatchEvent(new Event("input", { bubbles: true })));
      }));
      await page.keyboard.press("Escape");
      return ms;
    });
    out.quickFilter = median(filters);
  } finally {
    await ctx.close();
  }
  return { out, errors };
}

async function mobile(browser, base, ui) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 740 } });
  // 手机版的后端只列页面名,打开哪页读哪页
  await ctx.addInitScript(([files, ui]) => {
    localStorage.setItem("minipad-mobile-look", JSON.stringify({ ui }));
    const names = Object.keys(files);
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      app: { async onBackButtonPress() { return { unregister: async () => {} }; } },
      core: {
        async invoke(command, args = {}) {
          if (command === "mobile_list_books") return [{ name: "", notes: names }];
          if (command === "mobile_read_note") return { content: files[args.name], unreadable: false, reason: null };
          if (command === "mobile_save_note") return { conflict_name: null };
          if (command === "mobile_webdav_status") return { state: "idle", message: "", history: [] };
          return null;
        },
      },
    };
  }, [files, ui]);
  await ctx.addInitScript(helpers);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const out = {};
  try {
    const t0 = Date.now();
    await page.goto(base + "/mobile.html");
    await page.waitForFunction(() => window.__bench.title() === "第 1 页", null, { timeout: 30000 });
    out.startup = Date.now() - t0;
    // 打开抽屉,点一页换过去(换过去以后抽屉自己关上)
    const switches = [];
    out.openDrawer = await repeat(3, async (i) => {
      const ms = await page.evaluate(() => __bench.time(() => document.getElementById("open-drawer").click(), () => document.querySelector("#notes-list button")));
      const n = [2500, 4000, 10][i];
      switches.push(await page.evaluate(([name, title]) => {
        const button = [...document.querySelectorAll("#notes-list button")].find((b) => b.textContent === name);
        return __bench.time(() => button.click(), () => __bench.title() === title);
      }, [pageName(n), `第 ${n} 页`]));
      return ms;
    });
    out.switch = median(switches);
    // 从全部页面筛到几页;每次之前先清空筛选
    await page.click("#open-drawer");
    out.filter = await repeat(3, () => page.evaluate(async () => {
      const input = document.getElementById("note-filter");
      const filter = (value) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await __bench.time(() => filter(""));
      return __bench.time(() => filter("页面 12"));
    }));
  } finally {
    await ctx.close();
  }
  return { out, errors };
}

function table(title, metrics, columns) {
  const over = [];
  const rows = metrics.map(([key, label, limit]) => {
    const cells = columns.map(([name, r]) => {
      const ms = r.out[key];
      if (ms > limit) over.push(`${title} · ${name} · ${label}:${round(ms)} ms,上限 ${limit} ms`);
      return ms > limit ? `**${round(ms)} ✗**` : String(round(ms));
    });
    return `| ${label} | ${cells.join(" | ")} | ${limit} |`;
  });
  const head = `| ${title}(${PAGES} 页,毫秒) | ${columns.map(([name]) => name).join(" | ")} | 上限 |`;
  const line = `| --- | ${columns.map(() => "---:").join(" | ")} | ---: |`;
  return { text: [head, line, ...rows].join("\n"), over };
}

const browser = await chromium.launch();
const desktopServer = await serve(fileURLToPath(new URL("../src/", import.meta.url)));
const mobileServer = await serve(fileURLToPath(new URL("../mobile-dist/", import.meta.url)));
const url = (server) => `http://127.0.0.1:${server.address().port}`;
let desktopRuns, mobileRuns;
try {
  desktopRuns = [
    ["星空渐变", await desktop(browser, url(desktopServer), { ui_style: "starry" })],
    ["语雀纸感", await desktop(browser, url(desktopServer), { ui_style: "paper" })],
    ["侧拉页面列表(钉住)", await desktop(browser, url(desktopServer), { ui_style: "starry", tab_overflow: "drawer", tab_drawer_pinned: true })],
  ];
  mobileRuns = [
    ["星空渐变", await mobile(browser, url(mobileServer), "starry")],
    ["语雀纸感", await mobile(browser, url(mobileServer), "paper")],
  ];
} finally {
  await browser.close();
  for (const server of [desktopServer, mobileServer]) {
    server.closeAllConnections();
    server.close();
  }
}

const d = table("电脑版", DESKTOP, desktopRuns);
const m = table("手机版", MOBILE, mobileRuns);
const errors = [...desktopRuns, ...mobileRuns].flatMap(([name, r]) => r.errors.map((e) => `${name}:${e}`));
const report = [d.text, "", m.text, ""].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 性能基准\n\n浏览器预览(模拟后端)里 ${PAGES} 页的笔记本,见 scripts/bench.mjs。\n\n${report}\n`);
}
for (const e of errors) console.error("页面出错:" + e);
const over = [...d.over, ...m.over];
for (const o of over) console.error("超过上限:" + o);
if (check && (over.length || errors.length)) process.exit(1);
