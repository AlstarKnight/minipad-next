// ---------- 片段和行内计算(0.5.1) ----------
// 片段:打触发词再按 Tab(或空格),换成设好的内容(可以用 {{日期}} 这些变量和 Markdown)。
// 行内计算:打 12*3.5= 再按 Tab(或者设成打 = 就算),在 = 后面写上结果。代码块、行内代码里都不管。
// 电脑和手机共用;手机只有行内计算(打 = 就算)
import { $prose, Plugin, PluginKey, TextSelection, Slice, closeHistory, parserCtx } from "../vendor/milkdown.js";
import { findExpression, formatResult } from "./calc.js";
import { fillVars, CURSOR } from "./vars.js";

// 和后端的 default_snippets 一样(设置里「恢复默认片段」用)
export const DEFAULT_SNIPPETS = [
  { trigger: ";rq", text: "{{日期}}" },
  { trigger: ";sj", text: "{{时间}}" },
  { trigger: ";xq", text: "{{星期}}" },
];

let opts = { snippets: [], snippetKey: "off", calcKey: "off", decimals: "auto", thousands: false, dateFormat: "" };
let host = {
  // 算不出来时提示一句
  notify: () => {},
  // 片段里 {{标题}}、{{笔记本}} 用的:当前页面的名字和笔记本
  context: () => ({ title: "", book: "" }),
};

export function setExpandHost(h) {
  host = { ...host, ...h };
}

// 电脑用设置里的字段;手机只传 calc_key
export function applyExpandSettings(s) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  opts = {
    snippets: Array.isArray(s.snippets) ? s.snippets.filter((x) => x?.trigger) : [],
    snippetKey: pick(s.snippet_key, ["tab", "space", "off"], "off"),
    calcKey: pick(s.calc_key, ["tab", "equals", "off"], "off"),
    decimals: String(s.calc_decimals ?? "auto"),
    thousands: s.calc_thousands === true,
    dateFormat: s.date_format || "",
  };
}

// 全角的 ；，这些当半角比(中文标点下打的 ；rq 也能展开)
const half = (s) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 光标前面的文字(同一段里的);光标在代码里、或者选中了文字时返回 null
function textBefore($pos, empty = true) {
  if (!empty || !$pos.parent.isTextblock || $pos.parent.type.spec.code || $pos.marks().some((m) => m.type.spec.code)) return null;
  return $pos.parent.textBetween(0, $pos.parentOffset, null, "￼");
}

// 写上结果或者展开片段单独算一步:Ctrl+Z 先撤销它;接着打的字另算一步
function apart(view, tr) {
  view.dispatch(closeHistory(tr).scrollIntoView());
  view.dispatch(closeHistory(view.state.tr));
}

function result(found) {
  if (Number.isFinite(found.value)) return formatResult(found.value, opts.decimals, opts.thousands);
  host.notify(`算不出来:${found.expr}`);
  return null;
}

// Tab:光标前面是 算式= 就写上结果
function calcAtCursor(view) {
  const { $from, empty } = view.state.selection;
  const before = textBefore($from, empty);
  if (!before || !/[=＝]$/.test(before)) return false;
  const found = findExpression(before.slice(0, -1));
  if (!found) return false;
  const text = result(found);
  if (text != null) apart(view, view.state.tr.insertText(text));
  return true;
}

// 打 = 就算:打的 = 后面跟着结果
function calcOnEquals(view, from, to, typed) {
  const before = textBefore(view.state.doc.resolve(from), from === to);
  const found = before != null && findExpression(before);
  const text = found && result(found);
  if (text == null) return false;
  view.dispatch(view.state.tr.insertText(typed, from, to));
  apart(view, view.state.tr.insertText(text));
  return true;
}

// 光标前面的触发词对应的片段(有好几个对得上时用最长的)。触发词以字母或数字开头时,前面不能紧挨着字母或数字
function snippetBefore(before) {
  const text = half(before);
  let hit = null;
  for (const s of opts.snippets) {
    const t = half(s.trigger);
    if (!text.endsWith(t) || (hit && hit.trigger.length >= t.length)) continue;
    if (/^[A-Za-z0-9]/.test(t) && /[A-Za-z0-9]$/.test(text.slice(0, -t.length))) continue;
    hit = s;
  }
  return hit;
}

function expandAtCursor(view, ctx, typed) {
  const { state } = view;
  const { $from, empty } = state.selection;
  const before = textBefore($from, empty);
  const snippet = before && snippetBefore(before);
  if (!snippet) return false;
  const md = fillVars(snippet.text, { dateFormat: opts.dateFormat, ...host.context(), cursor: true });
  const from = $from.pos - snippet.trigger.length;
  const doc = ctx.get(parserCtx)(md);
  // 一段文字就接在这一段里;好几段时第一段和最后一段接上前后的文字(和粘贴一样)
  const tr = state.tr.replaceRange(from, $from.pos, Slice.maxOpen(doc.content));
  let end = tr.mapping.map($from.pos);
  let at = null;
  tr.doc.nodesBetween(from, end, (node, pos) => {
    if (at == null && node.isText && node.text.includes(CURSOR)) at = pos + node.text.indexOf(CURSOR);
    return at == null;
  });
  if (at != null) {
    tr.delete(at, at + 1);
    end = at;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(end)));
  if (typed && at == null) tr.insertText(typed);
  apart(view, tr);
  return true;
}

const key = new PluginKey("minipad-expand");

export const expandPlugin = $prose(
  (ctx) =>
    new Plugin({
      key,
      props: {
        handleKeyDown(view, e) {
          if (e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
          let done = false;
          if (e.key === "Tab") done = (opts.calcKey === "tab" && calcAtCursor(view)) || (opts.snippetKey === "tab" && expandAtCursor(view, ctx, ""));
          else if (e.key === " " && opts.snippetKey === "space") done = expandAtCursor(view, ctx, " ");
          if (done) e.preventDefault();
          return done;
        },
        handleTextInput(view, from, to, text) {
          if (opts.calcKey === "equals" && (text === "=" || text === "＝")) return calcOnEquals(view, from, to, text);
          return false;
        },
      },
    }),
);
