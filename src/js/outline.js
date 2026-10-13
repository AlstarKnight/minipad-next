// ---------- 悬浮目录:列出这一页的标题,点一下跳过去 ----------
// 设置里打开(默认关闭)。平时收起成一列短线(每个标题一条,正在看的那一节亮起来),鼠标移上去展开成目录;
// 也可以一直展开放在编辑区旁边,窗口太窄、放不下目录和正文时自动收起成短线。
// 放在左边还是右边、显示到几级标题、宽度、展开时背景的不透明度、当前标题的颜色都在设置里改(见 settings.js)
import { $prose, Plugin, TextSelection } from "../vendor/milkdown.js";
import { $ } from "./dom.js";
import { parseAccent, gradientOf } from "./accent.js";

// 一直展开时,正文至少要留这么宽,不然收起成短线(默认的窗口宽 440,目录宽 200 时刚好放得下)
const MIN_TEXT = 220;
// 标题滚到离编辑区顶部不到这么远,就算看到了这一节
const READ_LINE = 40;

let view = null;
let opts = { enabled: false, mode: "hover", side: "right", depth: 3, width: 200 };
// 这一页的标题:{ pos, level, text },pos 是标题在文档里的位置
let headings = [];
let active = -1;
let timer = 0;
let frame = 0;
// 点了目录里的标题以后,这个标题一直亮着,直到滚动停下来以后又被滚动过
// (跳到最后几节时页面已经滚到底,不然会按"滚到底"算成最后一个标题)
let lock = null;

// 文档变了(打字、换页、文件在别处被改过)就重新列一遍标题
export const outlinePlugin = $prose(
  () =>
    new Plugin({
      view(v) {
        view = v;
        schedule();
        return {
          update(next, prev) {
            view = next;
            if (next.state.doc !== prev.doc) schedule();
          },
        };
      },
    }),
);

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 60);
}

// 设置里的宽度、不透明度、颜色放到 el 上(设置里的预览也用)。颜色空着跟随强调色,渐变色时亮起来的短线也是渐变
export function outlineVars(el, { width, opacity, color }) {
  el.style.setProperty("--ol-width", `${width}px`);
  el.style.setProperty("--ol-alpha", `${opacity}%`);
  const c = parseAccent(color);
  if (c) {
    el.style.setProperty("--ol-c", c.from);
    el.style.setProperty("--ol-grad", c.to ? gradientOf(c.stops, c.deg) : c.from);
  } else {
    el.style.removeProperty("--ol-c");
    el.style.removeProperty("--ol-grad");
  }
}

export function applyOutlineSettings(s) {
  opts = {
    enabled: !!s.outline_enabled,
    mode: s.outline_mode === "pinned" ? "pinned" : "hover",
    side: s.outline_side === "left" ? "left" : "right",
    depth: Math.min(6, Math.max(1, Number(s.outline_depth) || 3)),
    width: Math.min(360, Math.max(140, Number(s.outline_width) || 200)),
  };
  outlineVars($("#main"), { width: opts.width, opacity: Math.min(100, Math.max(40, Number(s.outline_opacity) || 100)), color: s.outline_color });
  layout();
  rebuild();
}

// 一直展开但放不下时按收起处理;右边的短线让开编辑区的滚动条
function layout() {
  const main = $("#main");
  const pinned = opts.mode === "pinned" && main.clientWidth >= opts.width + MIN_TEXT;
  main.dataset.outline = opts.enabled ? (pinned ? "pinned" : "hover") : "";
  main.dataset.olSide = opts.side;
  const ed = $("#editor");
  main.style.setProperty("--sbw", `${ed.offsetWidth - ed.clientWidth}px`);
}

function rebuild() {
  clearTimeout(timer);
  const box = $("#outline");
  if (!opts.enabled || !view) {
    box.hidden = true;
    headings = [];
    active = -1;
    return;
  }
  const list = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const text = node.textContent.trim();
      if (text && node.attrs.level <= opts.depth) list.push({ pos, level: node.attrs.level, text });
      return false;
    }
    // 引用、列表里的标题也算;段落、代码块里面不用再找
    return !node.isTextblock;
  });
  headings = list;
  lock = null;
  layout();
  render();
  active = -2;
  updateActive();
}

function render() {
  const box = $("#outline");
  const top = Math.min(...headings.map((h) => h.level));
  box.querySelector(".ol-strip").replaceChildren(
    ...headings.map((h) => {
      const i = document.createElement("i");
      i.style.setProperty("--d", String(h.level - top));
      return i;
    }),
  );
  box.querySelector(".ol-list").replaceChildren(
    ...headings.map((h, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = h.level === top ? "ol-item top" : "ol-item";
      b.textContent = h.text;
      b.title = h.text;
      b.dataset.i = String(i);
      b.style.setProperty("--d", String(h.level - top));
      return b;
    }),
  );
  box.querySelector(".ol-empty").hidden = headings.length > 0;
  // 收起的时候没有标题就什么也不显示;一直展开时显示"这一页没有标题"
  box.hidden = !headings.length && $("#main").dataset.outline !== "pinned";
}

// 正在看的是哪一节:最后一个滚到(或越过)编辑区顶部的标题;滚到底时,最后一个露出来的标题也算
function updateActive() {
  frame = 0;
  if (!headings.length || !view) return setActive(-1);
  const sc = $("#editor");
  if (lock) {
    if (!lock.settled || Math.abs(sc.scrollTop - lock.top) <= 2) return setActive(lock.i);
    lock = null;
  }
  const r = sc.getBoundingClientRect();
  const tops = headings.map((h) => {
    const dom = view.nodeDOM(h.pos);
    return dom?.getBoundingClientRect ? dom.getBoundingClientRect().top : Infinity;
  });
  let at = -1;
  tops.forEach((t, i) => t <= r.top + READ_LINE && (at = i));
  if (sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) {
    tops.forEach((t, i) => t < r.bottom && (at = Math.max(at, i)));
  }
  setActive(at);
}

function setActive(i) {
  if (i === active) return;
  active = i;
  const box = $("#outline");
  for (const [n, el] of [...box.querySelectorAll(".ol-strip i")].entries()) el.classList.toggle("on", n === i);
  for (const el of box.querySelectorAll(".ol-item")) {
    const on = Number(el.dataset.i) === i;
    el.classList.toggle("on", on);
    if (on) el.setAttribute("aria-current", "location");
    else el.removeAttribute("aria-current");
  }
  // 目录很长时,让当前标题留在看得见的地方
  const item = box.querySelector(".ol-item.on");
  const list = box.querySelector(".ol-panel");
  if (item && list.scrollHeight > list.clientHeight) {
    const it = item.offsetTop - list.offsetTop;
    if (it < list.scrollTop || it + item.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = it - list.clientHeight / 3;
  }
}

// 点目录里的标题:滚到这个标题,光标放在标题末尾
function jump(i) {
  const h = headings[i];
  const dom = h && view?.nodeDOM(h.pos);
  if (!dom) return;
  const sc = $("#editor");
  const want = sc.scrollTop + dom.getBoundingClientRect().top - sc.getBoundingClientRect().top - 8;
  const top = Math.round(Math.min(Math.max(0, want), sc.scrollHeight - sc.clientHeight));
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = Math.abs(top - sc.scrollTop) < 1;
  lock = { i, settled: still, top: sc.scrollTop };
  if (!still) {
    sc.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    // 万一没有收到 scrollend,一秒以后也算停下来了
    const mine = lock;
    setTimeout(() => settle(mine), 1000);
  }
  const node = view.state.doc.nodeAt(h.pos);
  if (node) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, h.pos + node.nodeSize - 1)));
  if (view.editable) view.focus();
  setActive(i);
}

function settle(l) {
  if (l !== lock || l.settled) return;
  l.settled = true;
  l.top = $("#editor").scrollTop;
}

export function bindOutline() {
  const box = $("#outline");
  $("#editor").addEventListener("scrollend", () => lock && settle(lock));
  box.querySelector(".ol-list").addEventListener("click", (e) => {
    const item = e.target.closest(".ol-item");
    if (item) jump(Number(item.dataset.i));
  });
  // 点目录不把焦点从编辑区拿走(点完光标在标题那里)
  box.addEventListener("mousedown", (e) => e.target.closest(".ol-item") && e.preventDefault());
  $("#editor").addEventListener(
    "scroll",
    () => {
      if (headings.length && !frame) frame = requestAnimationFrame(updateActive);
    },
    { passive: true },
  );
  // 窗口变宽变窄时看看一直展开还放不放得下
  new ResizeObserver(() => {
    if (!opts.enabled) return;
    const was = $("#main").dataset.outline;
    layout();
    if ($("#main").dataset.outline !== was) render();
  }).observe($("#main"));
}
