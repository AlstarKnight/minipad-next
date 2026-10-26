// ---------- 编辑器里的页面链接 [[页面名]](0.5.0):显示、点击、补全 ----------
// 只是装饰(和本地路径一样),文档和文件里还是原样的文字,光标、撤销、复制都和普通文字一样。
// 有哪些页面、点了怎么打开由外面接上(setPageLinkHost):主窗口、小窗、手机各接各的
import { $prose, Plugin, PluginKey, Decoration, DecorationSet, TextSelection } from "../vendor/milkdown.js";
import { findPageLinks, makeIndex, resolveTarget, linkable, labelOf, parseTarget } from "./pagelinks.js";
import { pageScore, nameScore, termsOf } from "./match.js";
import { parseAccent } from "./accent.js";

let host = {
  // 当前页面所在的笔记本("" 是默认笔记本);没有页面时是 null
  home: () => null,
  // 全部笔记本和页面名:[{ name, pages: [页面名] }]
  books: () => [],
  // 补全的候选:[{ book, name }],按没打字时要列的顺序(最近打开的在前,然后是当前笔记本)
  candidates: () => [],
  // 打开链接指向的页面,页面不存在就新建
  open: () => {},
};
let opts = { on: false, click: "ctrl", suggest: "brackets", cn: true, pinyin: true, brackets: "faint", mobile: false, tapEdit: false };
const key = new PluginKey("minipad-page-links");
const EXTERNAL = "minipad-external";
let view = null;
// 页面名单或者设置变了就加一;编辑器里的链接是按哪一版算的记在插件状态里,对不上就重算
let version = 0;
let index = null;

export function setPageLinkHost(h) {
  host = { ...host, ...h };
  pageNamesChanged();
}

// 页面名单变了(新建、删除、改名、移动、同步回来新页面):重新判断链接存不存在
export function pageNamesChanged() {
  index = null;
  candidates = null;
  version++;
  queueRefresh();
}

let refreshQueued = false;
function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    refresh();
  });
}

export function linkIndex() {
  return (index ||= makeIndex(host.books()));
}

function refresh() {
  if (view && key.getState(view.state).version !== version) view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false));
}

export const pageLinksOn = () => opts.on;

// 设置:电脑用设置里的字段,手机用外观设置里同名的字段;extra 是手机才有的(mobile、tapEdit)
export function applyPageLinkSettings(s, extra = {}) {
  const next = {
    on: s.page_links !== false,
    click: s.page_link_click === "click" ? "click" : "ctrl",
    suggest: ["typing", "off"].includes(s.page_link_suggest) ? s.page_link_suggest : "brackets",
    cn: s.page_link_cn_brackets !== false,
    pinyin: s.pinyin_match !== false,
    brackets: ["show", "hide"].includes(s.page_link_brackets) ? s.page_link_brackets : "faint",
    mobile: false,
    tapEdit: false,
    ...extra,
  };
  const root = document.getElementById("editor");
  if (root) {
    root.dataset.pageLinkBrackets = next.brackets;
    root.dataset.pageLinkUnderline = ["solid", "dashed", "none"].includes(s.page_link_underline) ? s.page_link_underline : "hover";
    paint(root, "page-link", s.page_link_color);
    paint(root, "page-link-broken", s.page_link_broken_color);
  }
  const changed = JSON.stringify(next) !== JSON.stringify(opts);
  opts = next;
  if (!opts.on || opts.suggest === "off") closeMenu();
  if (changed) {
    version++;
    queueRefresh();
  }
}

// 颜色:纯色直接用;渐变色写成背景再裁成文字的形状(和本地路径一样)
function paint(root, name, value) {
  const c = parseAccent(value);
  if (c) root.style.setProperty(`--${name}-color`, c.from);
  else root.style.removeProperty(`--${name}-color`);
  root.style.setProperty(`--${name}-gradient`, c?.to ? value : "none");
  root.toggleAttribute(`data-${name}-gradient`, !!c?.to);
}

// ---------- 显示 ----------
function decorate(doc, from = 0, to = doc.content.size) {
  const home = opts.on ? host.home() : null;
  if (home == null) return [];
  const idx = linkIndex();
  const hint = opts.mobile ? "" : opts.click === "click" ? "点击" : "Ctrl+点击";
  const out = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    node.forEach((child, offset) => {
      // 行内代码、普通链接里的不算
      if (!child.isText || child.marks.some((m) => m.type.spec.code || m.type.name === "link")) return;
      for (const l of findPageLinks(child.text)) {
        const a = pos + 1 + offset + l.from;
        const b = pos + 1 + offset + l.to;
        const r = resolveTarget(idx, l.target, home);
        const title = r.book == null
          ? `没有「${r.bookLabel}」这个笔记本`
          : r.exists ? `${hint}打开「${r.page}」` : `还没有「${r.page}」这一页,${hint}新建`;
        out.push(Decoration.inline(a, b, { class: r.exists ? "page-link" : "page-link broken", "data-page-link": l.target, title }, { pageLink: true, target: l.target }));
        out.push(Decoration.inline(a, a + 2, { class: "page-link-mark" }));
        out.push(Decoration.inline(b - 2, b, { class: "page-link-mark" }));
      }
    });
    return false;
  });
  return out;
}

// 文档变了只重算改到的那几段(几万字的页面每打一个字都整篇重算太慢)
function apply(tr, old) {
  if (tr.getMeta(key)) return { deco: DecorationSet.create(tr.doc, decorate(tr.doc)), version };
  if (!tr.docChanged) return old;
  let deco = old.deco.map(tr.mapping, tr.doc);
  const blocks = new Map();
  tr.mapping.maps.forEach((stepMap, i) => {
    stepMap.forEach((_, __, start, end) => {
      const rest = tr.mapping.slice(i + 1);
      const from = Math.max(0, rest.map(start) - 1);
      const to = Math.min(tr.doc.content.size, rest.map(end) + 1);
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) {
          blocks.set(pos, [pos, pos + node.nodeSize]);
          return false;
        }
        return !node.type.spec.code;
      });
    });
  });
  for (const [from, to] of blocks.values()) {
    deco = deco.remove(deco.find(from, to));
    deco = deco.add(tr.doc, decorate(tr.doc, from, to));
  }
  return { deco, version: old.version };
}

// 方括号设成「隐藏」时,光标所在的那个链接的方括号照样显示,好改
function decorations(state) {
  const { deco } = key.getState(state);
  if (opts.brackets !== "hide") return deco;
  const { from, to } = state.selection;
  const near = deco.find(from, to, (spec) => spec.pageLink);
  return near.length ? deco.add(state.doc, near.map((d) => Decoration.inline(d.from, d.to, { class: "page-link-near" }))) : deco;
}

// 点到的那个链接
function linkAt(v, el) {
  let pos;
  try {
    pos = v.posAtDOM(el, 0);
  } catch {
    return null;
  }
  return key.getState(v.state).deco.find(pos, pos, (spec) => spec.pageLink).find((d) => d.from <= pos && pos < d.to) || null;
}

function click(v, e) {
  const el = e.target.closest?.("[data-page-link]");
  if (!el || !v.dom.contains(el) || !opts.on) return false;
  // 电脑:设置里选的 Ctrl+点击 / 单击;手机:不能编辑时(阅读模式)点一下就打开,编辑时看「编辑时点链接也直接打开」
  const go = opts.mobile ? !v.editable || opts.tapEdit : opts.click === "click" || e.ctrlKey || e.metaKey;
  if (!go) return false;
  const d = linkAt(v, el);
  if (!d) return false;
  e.preventDefault();
  host.open(d.spec.target);
  return true;
}

// ---------- 中文标点:【【 换成 [[,链接里的 】】 换成 ]] ----------
function convertBrackets(trs, oldState, state) {
  if (!opts.on || !opts.cn) return null;
  // 只看刚打进来(或者粘贴进来)的字,删字、别处来的修改不算
  if (!trs.some((tr) => tr.docChanged && !tr.getMeta(EXTERNAL) && tr.steps.some((s) => s.slice?.content.size))) return null;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code || $from.marks().some((m) => m.type.spec.code)) return null;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 82), $from.parentOffset, "\n", "￼");
  if (before.endsWith("【【")) return state.tr.insertText("[[", $from.pos - 2, $from.pos);
  if (/\[\[[^\[\]\n￼]*】】$/.test(before)) return state.tr.insertText("]]", $from.pos - 2, $from.pos);
  return null;
}

// ---------- 补全:打 [[ 弹出页面列表 ----------
let menu = null;
// 正在补全的那一段:{ from, to, query },from 是 [[ 后面的位置
let ctx = null;
let items = [];
let sel = 0;
// 按 Esc 关掉的那个 [[(光标离开以后再回来才重新弹)
let dismissed = -1;
let candidates = null;
let shownQuery = null;

function context(state) {
  if (!opts.on || opts.suggest === "off" || host.home() == null) return null;
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code || $from.marks().some((m) => m.type.spec.code)) return null;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 82), $from.parentOffset, "\n", "￼");
  const m = /\[\[([^\[\]\n￼]*)$/.exec(before);
  if (!m || (opts.suggest === "typing" && !m[1])) return null;
  return { from: $from.pos - m[1].length, to: $from.pos, query: m[1] };
}

// 补全要列的页面:没打字时按 host 给的顺序;打了字按分数,同分的照原来的顺序。
// 打 笔记本/页面 时先按笔记本筛再按页面筛
function rank(query) {
  candidates ||= host.candidates().filter((c) => linkable(c.name));
  const t = parseTarget(query);
  const terms = termsOf(t.page);
  const bookTerm = t.book?.toLowerCase();
  if (!terms.length && bookTerm == null) return candidates.slice(0, 50);
  const scored = [];
  candidates.forEach((c, i) => {
    const label = labelOf(c.book);
    if (bookTerm && !nameScore(label, bookTerm, opts.pinyin)) return;
    const s = terms.length ? pageScore(c.name, bookTerm == null ? label : "", terms, opts.pinyin) : 0;
    if (s >= 0) scored.push({ c, s, i });
  });
  scored.sort((x, y) => y.s - x.s || x.i - y.i);
  return scored.slice(0, 50).map((x) => x.c);
}

function ensureMenu() {
  if (menu) return menu;
  menu = document.createElement("div");
  menu.className = "menu page-link-menu";
  menu.setAttribute("role", "listbox");
  menu.hidden = true;
  // 点列表不让编辑区失去焦点(手机上键盘也不收起)
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("pointerdown", (e) => e.preventDefault());
  document.body.append(menu);
  return menu;
}

function closeMenu() {
  if (menu) menu.hidden = true;
  ctx = null;
  items = [];
  shownQuery = null;
  // 下次打 [[ 时重新取(当前页面、最近打开的可能变了)
  candidates = null;
}

function updateMenu(v) {
  const next = v.hasFocus() ? context(v.state) : null;
  if (!next || next.from === dismissed) {
    if (!next) dismissed = -1;
    closeMenu();
    return;
  }
  ctx = next;
  if (next.query !== shownQuery) {
    shownQuery = next.query;
    items = rank(next.query);
    sel = 0;
    render();
  }
  if (!items.length) {
    menu.hidden = true;
    return;
  }
  place(v);
}

function render() {
  const home = host.home();
  ensureMenu().replaceChildren(...items.map((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.tabIndex = -1;
    b.setAttribute("role", "option");
    b.className = i === sel ? "active" : "";
    const name = document.createElement("span");
    name.textContent = c.name;
    b.append(name);
    if (c.book !== home) {
      const where = document.createElement("small");
      where.textContent = labelOf(c.book);
      b.append(where);
    }
    b.addEventListener("click", () => pick(view, i));
    return b;
  }));
  menu.hidden = !items.length;
}

function place(v) {
  menu.hidden = false;
  let c;
  try {
    c = v.coordsAtPos(ctx.from - 2);
  } catch {
    return;
  }
  const vv = window.visualViewport;
  const top = vv ? vv.offsetTop : 0;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const h = menu.offsetHeight;
  const below = bottom - c.bottom - 6;
  menu.style.top = `${below >= h || below >= c.top - top ? c.bottom + 4 : Math.max(top + 4, c.top - h - 4)}px`;
  menu.style.left = `${Math.max(4, Math.min(c.left, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.children[sel]?.scrollIntoView({ block: "nearest" });
}

function move(d) {
  sel = (sel + d + items.length) % items.length;
  [...menu.children].forEach((b, i) => b.classList.toggle("active", i === sel));
  menu.children[sel]?.scrollIntoView({ block: "nearest" });
}

// 填进去:当前笔记本的写短的,别的笔记本写上笔记本名;后面已经有 ]] 就不再补
function pick(v, i) {
  const c = items[i];
  if (!c || !ctx) return;
  const home = host.home();
  const text = c.book === home ? c.name : `${labelOf(c.book)}/${c.name}`;
  const { state } = v;
  const close = state.doc.textBetween(ctx.to, Math.min(ctx.to + 2, state.selection.$from.end())) === "]]";
  const tr = state.tr.insertText(text + (close ? "" : "]]"), ctx.from, ctx.to);
  tr.setSelection(TextSelection.create(tr.doc, ctx.from + text.length + 2));
  closeMenu();
  v.dispatch(tr.scrollIntoView());
  v.focus();
}

function keydown(v, e) {
  if (!ctx || !items.length || menu?.hidden || e.isComposing || e.keyCode === 229) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") move(e.key === "ArrowDown" ? 1 : -1);
  else if (e.key === "Enter" || e.key === "Tab") pick(v, sel);
  else if (e.key === "Escape") {
    dismissed = ctx.from;
    closeMenu();
  } else return false;
  // 不再传给窗口(Esc 在窗口上是隐藏窗口)
  e.stopPropagation();
  return true;
}

// 页面滚动时列表跟着光标走
document.addEventListener("scroll", () => ctx && view && menu && !menu.hidden && place(view), true);

export const pageLinkPlugin = $prose(() => new Plugin({
  key,
  state: {
    init: (_, state) => ({ deco: DecorationSet.create(state.doc, decorate(state.doc)), version }),
    apply,
  },
  appendTransaction: convertBrackets,
  props: {
    decorations,
    handleKeyDown: keydown,
    handleDOMEvents: {
      click,
      blur: (v) => {
        // 点补全列表时焦点不会离开;别的情况失去焦点就收起
        setTimeout(() => !v.hasFocus() && closeMenu(), 0);
        return false;
      },
    },
  },
  view(v) {
    view = v;
    return {
      update(v2, prev) {
        // 换页时放回来的是以前的编辑状态,那时的名单可能已经过时
        if (key.getState(v2.state).version !== version) queueRefresh();
        if (v2.state.doc !== prev.doc || !v2.state.selection.eq(prev.selection)) updateMenu(v2);
      },
      destroy() {
        closeMenu();
        if (view === v) view = null;
      },
    };
  },
}));
