// ---------- 查找栏:在当前页面里查找(Ctrl+F)和替换(Ctrl+H) ----------
// 找到的地方在编辑区里高亮,当前这个颜色更深;输入框里回车找下一个,Shift+回车找上一个。
// 栏放在编辑区上方还是下方、高亮用什么颜色,在设置里改(见 applyFindAppearance)
import { $ } from "./dom.js";
import { current } from "./state.js";
import { editorView, editorSelectionText, focusEditorView } from "./editor.js";
import { setFind, findNext, findState, onFindChange, replaceCurrent, replaceAll, MAX_MATCHES } from "./find.js";
import { parseAccent, gradientOf } from "./accent.js";
import { toast, closeOverlays } from "./ui.js";

const opts = { query: "", caseSensitive: false, wholeWord: false, regex: false };
// 边打字边找时从这里往后找:打开查找栏时的光标位置,之后是当前的匹配
let origin = null;

export function findOpen() {
  return !$("#find-bar").hidden;
}

function showReplace(on) {
  $("#find-replace").hidden = !on;
  $("#find-toggle").setAttribute("aria-expanded", String(on));
}

// 打开查找栏;replace 时连替换那一行一起打开。
// 在编辑区里选中了一段文字(不跨行)就拿来当查找的内容;焦点已经在查找栏里时不换
export function openFind({ replace = false } = {}) {
  closeOverlays();
  const view = editorView();
  const wasOpen = findOpen();
  $("#find-bar").hidden = false;
  showReplace(replace || (wasOpen && !$("#find-replace").hidden));
  const input = $("#find-input");
  const sel = current() && view.hasFocus() ? editorSelectionText() : "";
  if (sel && !sel.includes("\n") && sel.length <= 300) input.value = sel;
  origin = view.state.selection.from;
  search(true);
  const target = replace && input.value ? $("#replace-input") : input;
  target.focus();
  target.select();
}

// 关掉查找栏(去掉高亮,光标回到编辑区,停在刚才找到的地方)。返回原来开着没有
export function closeFind() {
  if (!findOpen()) return false;
  $("#find-bar").hidden = true;
  setFind(editorView(), null);
  focusEditorView();
  return true;
}

// F3 / Shift+F3:还没有要找的内容时打开查找栏
export function findAgain(dir) {
  if (!findOpen() || !opts.query) return openFind();
  go(dir);
}

function search(select) {
  opts.query = $("#find-input").value;
  setFind(editorView(), opts, { select, origin });
  showCount();
}

function go(dir) {
  const view = editorView();
  if (findNext(view, dir)) origin = view.state.selection.from;
}

// 「3/12」、「12 个」、「无结果」;按钮能不能点
function showCount() {
  if (!findOpen()) return;
  const view = editorView();
  const st = findState(view);
  const n = st.matches.length;
  const count = $("#find-count");
  count.classList.toggle("error", !!st.error);
  count.title = st.error || "";
  if (st.error) count.textContent = "正则有误";
  else if (!opts.query) count.textContent = "";
  else if (!n) count.textContent = "无结果";
  else {
    const total = n >= MAX_MATCHES ? `${n}+` : String(n);
    count.textContent = st.current >= 0 ? `${st.current + 1}/${total}` : `${total} 个`;
  }
  $("#find-input").parentElement.classList.toggle("none", !!opts.query && !n);
  $("#find-prev").disabled = $("#find-next").disabled = !n;
  const canReplace = n > 0 && view.editable;
  $("#replace-one").disabled = $("#replace-all").disabled = !canReplace;
}

function toggle(name) {
  opts[name] = !opts[name];
  $(`#find-bar [data-opt="${name}"]`).setAttribute("aria-pressed", String(opts[name]));
  search(true);
}

function doReplace() {
  const view = editorView();
  if (replaceCurrent(view, $("#replace-input").value)) origin = view.state.selection.from;
}

function doReplaceAll() {
  const n = replaceAll(editorView(), $("#replace-input").value);
  if (n) toast(`替换了 ${n} 处(Ctrl+Z 可以撤销)`);
}

// 设置里的查找栏位置和高亮颜色
export function applyFindAppearance(s) {
  const root = document.documentElement;
  root.dataset.findPos = s.find_bar_pos === "bottom" ? "bottom" : "top";
  findColors(root, s.find_color);
}

// 把高亮颜色放到 el 上(设置里的预览也用):淡的是所有匹配,深一点的是当前这个;渐变色的每一段都调淡。
// 空着跟随强调色(强调色是渐变时也是渐变)
export function findColors(el, value) {
  const c = parseAccent(value);
  const tint = (color, p) => `color-mix(in srgb, ${color} ${p}%, transparent)`;
  const mix = (p) => {
    if (!c) return gradientOf([tint("var(--accent)", p), tint("var(--accent-end, var(--accent))", p)]);
    return c.to ? gradientOf(c.stops.map((x) => tint(x, p)), c.deg) : tint(c.from, p);
  };
  el.style.setProperty("--find-soft", mix(30));
  el.style.setProperty("--find-strong", mix(62));
}

export function bindFind() {
  onFindChange(showCount);
  const input = $("#find-input");
  const rep = $("#replace-input");
  input.addEventListener("input", () => search(true));
  $("#find-toggle").addEventListener("click", () => {
    const on = $("#find-replace").hidden;
    showReplace(on);
    (on ? rep : input).focus();
  });
  for (const b of document.querySelectorAll("#find-bar [data-opt]")) {
    b.addEventListener("click", () => toggle(b.dataset.opt));
  }
  $("#find-prev").addEventListener("click", () => go(-1));
  $("#find-next").addEventListener("click", () => go(1));
  $("#find-close").addEventListener("click", closeFind);
  $("#replace-one").addEventListener("click", doReplace);
  $("#replace-all").addEventListener("click", doReplaceAll);
  // 点按钮不把焦点从输入框拿走,接着可以打字、按回车
  $("#find-bar").addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) e.preventDefault();
  });
  $("#find-bar").addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    } else if (e.altKey && !e.ctrlKey && (k === "c" || k === "w" || k === "r")) {
      e.preventDefault();
      toggle({ c: "caseSensitive", w: "wholeWord", r: "regex" }[k]);
    } else if (e.key === "Enter" && e.target === input) {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter" && e.target === rep) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) doReplaceAll();
      else doReplace();
    }
  });
}
