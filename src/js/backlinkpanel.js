// ---------- 反向链接面板(0.5.6):列出链接到当前页面的页面和那一行,点一下过去 ----------
// 设置里打开(默认关闭),放在编辑区右边(窗口太窄时放到下面)或者下面。
// 不另建索引:用页面链接的名单(0.5.0 的 linkIndex)和内存里各页的内容,
// 只在换页、页面名单变了、窗口回到前台时重新找一遍;关着时什么也不做
import { TextSelection } from "../vendor/milkdown.js";
import { $ } from "./dom.js";
import { api, isMiniWindow } from "./api.js";
import { state, book, current } from "./state.js";
import { focusEditor } from "./ui.js";
import { backlinks, labelOf } from "./pagelinks.js";
import { linkIndex, linkPosition, onPageNamesChanged } from "./pagelinkview.js";
import { editorView } from "./editor.js";
import { goTo } from "./tabs.js";
import { parseAccent, gradientOf } from "./accent.js";

// 放在右边时面板的宽度;编辑区至少要留这么宽,不然放到下面
const WIDTH = 200;
const MIN_TEXT = 220;

let opts = { on: false, place: "right", count: true };
let list = [];
// 正在显示的是哪一页的、什么样的结果:一样就不重画
let shownKey = "";
let timer = 0;

export function applyBacklinkSettings(s) {
  opts = { on: s.backlinks === true && !isMiniWindow, place: s.backlinks_place === "bottom" ? "bottom" : "right", count: s.backlinks_count !== false };
  const box = $("#backlinks");
  const c = parseAccent(s.backlinks_color || "");
  if (c) {
    box.style.setProperty("--bl-c", c.from);
    box.style.setProperty("--bl-grad", c.to ? gradientOf(c.stops, c.deg, c.positions) : "none");
  } else {
    box.style.removeProperty("--bl-c");
    box.style.removeProperty("--bl-grad");
  }
  box.toggleAttribute("data-gradient", !!c?.to);
  box.hidden = !opts.on;
  shownKey = "";
  layout();
  schedule(0);
}

function schedule(ms = 120) {
  if (!opts.on) return;
  clearTimeout(timer);
  timer = setTimeout(rebuild, ms);
}

function rebuild() {
  timer = 0;
  const b = book();
  const n = current();
  if (!opts.on || !b) return;
  const target = n ? { book: b.name, page: n.name } : null;
  const pages = state.books.flatMap((x) => x.notes.filter((p) => !p.unreadable).map((p) => ({ book: x.name, name: p.name, content: p.content })));
  list = target ? backlinks(pages, linkIndex(), target) : [];
  const key = JSON.stringify([target, list, opts.count]);
  if (key === shownKey) return;
  shownKey = key;
  render(target);
}

function render(target) {
  const box = $("#backlinks");
  box.querySelector(".bl-count").textContent = opts.count && target ? String(list.length) : "";
  const items = list.map((x, i) => {
    const item = document.createElement("div");
    item.className = "bl-item";
    const page = document.createElement("button");
    page.type = "button";
    page.className = "bl-page";
    page.dataset.i = i;
    page.textContent = x.name;
    // 别的笔记本的页面:后面写上是哪个笔记本
    if (x.book !== target.book) {
      const where = document.createElement("span");
      where.className = "bl-book";
      where.textContent = labelOf(x.book);
      page.append(" ", where);
    }
    item.append(page);
    x.lines.forEach((l, j) => {
      const line = document.createElement("button");
      line.type = "button";
      line.className = "bl-line";
      line.dataset.i = i;
      line.dataset.l = j;
      line.textContent = l.text;
      item.append(line);
    });
    return item;
  });
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "bl-empty";
    empty.textContent = target ? "没有页面链接到这一页" : "没有打开的页面";
    items.push(empty);
  }
  box.querySelector(".bl-list").replaceChildren(...items);
  layout();
}

// 放在右边还是下面(右边放不下时放到下面);放在下面时按内容定高度,最多占编辑区的四成
function layout() {
  const main = $("#main");
  if (!opts.on) {
    delete main.dataset.backlinks;
    return;
  }
  const place = opts.place === "right" && main.clientWidth >= WIDTH + MIN_TEXT ? "right" : "bottom";
  main.dataset.backlinks = place;
  main.style.setProperty("--bl-w", `${WIDTH}px`);
  if (place === "bottom") {
    const box = $("#backlinks");
    const h = Math.min(box.querySelector(".bl-title").offsetHeight + box.querySelector(".bl-list").scrollHeight + 10, Math.max(64, Math.round(main.clientHeight * 0.4)));
    main.style.setProperty("--bl-h", `${h}px`);
  }
}

// 打开那一页,光标放到那一行指向原来那一页的链接上(点页面名是第一行;找不到就只打开)
function jump(entry, line) {
  const from = { book: book()?.name, page: current()?.name };
  const b = state.books.find((x) => x.name === entry.book);
  const n = b?.notes.find((x) => x.name === entry.name);
  if (!n) return;
  goTo(b, n);
  if (n.mini || current() !== n) return;
  const view = editorView();
  const at = linkPosition(view.state.doc, entry.book, from, line.link);
  if (at != null) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).scrollIntoView());
  focusEditor();
}

export function bindBacklinks() {
  if (isMiniWindow) return;
  const box = $("#backlinks");
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    const entry = b && list[Number(b.dataset.i)];
    if (entry) jump(entry, entry.lines[Number(b.dataset.l || 0)]);
  });
  // 点面板不把焦点从编辑区拿走
  box.addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
  $("#editor").addEventListener("page-shown", () => schedule());
  onPageNamesChanged(() => schedule());
  // 回到前台时别处可能改过页面(同步、小窗):等读完磁盘再找
  api.listen("window-focus", () => schedule(800));
  new ResizeObserver(() => opts.on && layout()).observe($("#main"));
}
