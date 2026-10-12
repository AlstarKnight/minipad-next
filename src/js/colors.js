// ---------- 字体颜色和背景颜色 ----------
// Markdown 没有颜色的写法,所以存成 HTML 的 span(别的 Markdown 编辑器一般也认):
//   <span style="color: #df2a3f">红字</span>
//   <span style="background-color: #fbe9a6">黄底</span>
// 读文件时把成对的 <span style=…> 和 </span> 收拢成 textColor / textBg 节点,编辑器里就是两种文字标记
import { $markSchema, $remark } from "../vendor/milkdown.js";

// 颜色板:字体颜色在浅色、深色背景上都看得清;背景色在深色主题里会调淡(见 style.css)
export const TEXT_COLORS = [
  { name: "灰色", value: "#8c8c8c" },
  { name: "红色", value: "#df2a3f" },
  { name: "橙色", value: "#ed740c" },
  { name: "黄色", value: "#c99a06" },
  { name: "绿色", value: "#1f9c58" },
  { name: "蓝色", value: "#117cee" },
  { name: "紫色", value: "#8a3fd4" },
];
export const BG_COLORS = [
  { name: "灰色", value: "#e4e5e7" },
  { name: "红色", value: "#fbd4d0" },
  { name: "橙色", value: "#fde2c4" },
  { name: "黄色", value: "#fbe9a6" },
  { name: "绿色", value: "#d2f1d9" },
  { name: "蓝色", value: "#d3e6fd" },
  { name: "紫色", value: "#e6dbf8" },
];

// 只接受普通的颜色写法,别的(比如 url(...))不当颜色
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;
const cleanColor = (v) => {
  v = (v || "").trim();
  return COLOR.test(v) ? v : "";
};

function parseStyle(style) {
  const out = {};
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = cleanColor(part.slice(i + 1));
    if (!value) continue;
    if (key === "color") out.color = value;
    else if (key === "background-color" || key === "background") out.bg = value;
  }
  return out;
}

const OPEN = /^<span\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>$/i;
const CLOSE = /^<\/span\s*>$/i;

// 把一层里的 <span style> … </span> 收拢起来(里面可以再有 span)
function fold(children) {
  const out = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const m = node.type === "html" && OPEN.exec(node.value.trim());
    const style = m && parseStyle(m[1] ?? m[2]);
    if (!style || (!style.color && !style.bg)) {
      if (node.children) node.children = fold(node.children);
      out.push(node);
      continue;
    }
    // 找配对的 </span>
    let depth = 1;
    let j = i + 1;
    for (; j < children.length; j++) {
      const c = children[j];
      if (c.type !== "html") continue;
      const v = c.value.trim();
      if (/^<span[\s>]/i.test(v)) depth++;
      else if (CLOSE.test(v) && --depth === 0) break;
    }
    if (j >= children.length) {
      out.push(node);
      continue;
    }
    let inner = fold(children.slice(i + 1, j));
    if (style.bg) inner = [{ type: "textBg", bg: style.bg, children: inner }];
    if (style.color) inner = [{ type: "textColor", color: style.color, children: inner }];
    out.push(...inner);
    i = j;
  }
  return out;
}

export const colorSpans = $remark("minipadColorSpans", () => () => (tree) => {
  if (tree.children) tree.children = fold(tree.children);
});

// 写回文件时的样子
export const colorHandlers = {
  textColor: (node, _, state, info) => `<span style="color: ${node.color}">${state.containerPhrasing(node, info)}</span>`,
  textBg: (node, _, state, info) => `<span style="background-color: ${node.bg}">${state.containerPhrasing(node, info)}</span>`,
};

function colorMark(name, attr, mdType, cssProp) {
  return $markSchema(name, () => ({
    attrs: { [attr]: { default: "" } },
    inclusive: true,
    parseDOM: [{ tag: `span[data-${attr}]`, getAttrs: (dom) => ({ [attr]: cleanColor(dom.dataset[attr]) }) }],
    toDOM: (mark) => ["span", { [`data-${attr}`]: mark.attrs[attr], style: `${cssProp}: ${mark.attrs[attr]}` }, 0],
    parseMarkdown: {
      match: (node) => node.type === mdType,
      runner: (state, node, markType) => {
        state.openMark(markType, { [attr]: node[attr] });
        state.next(node.children);
        state.closeMark(markType);
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === name,
      runner: (state, mark) => {
        state.withMark(mark, mdType, undefined, { [attr]: mark.attrs[attr] });
      },
    },
  }));
}

// 背景色在页面上用 --mark-bg 变量,深色主题里调淡一些(见 style.css)
export const textColor = colorMark("text_color", "color", "textColor", "color");
export const textBg = colorMark("text_bg", "bg", "textBg", "--mark-bg");

// 给选中的文字换颜色;value 为空就去掉颜色。没选中文字时,接下来打的字用这个颜色
export function setColor(view, markName, value) {
  const { state } = view;
  const type = state.schema.marks[markName];
  const attr = markName === "text_color" ? "color" : "bg";
  const { from, to, empty } = state.selection;
  const tr = state.tr;
  if (empty) {
    tr.removeStoredMark(type);
    if (value) tr.addStoredMark(type.create({ [attr]: value }));
  } else {
    tr.removeMark(from, to, type);
    if (value) tr.addMark(from, to, type.create({ [attr]: value }));
  }
  view.dispatch(tr);
  view.focus();
}

// 选中的文字(或光标处)现在的颜色
export function colorAt(state, markName) {
  const type = state.schema.marks[markName];
  if (!type) return "";
  const { $from, from, to, empty } = state.selection;
  const marks = empty ? state.storedMarks || $from.marks() : [];
  let found = marks.find((m) => m.type === type);
  if (!empty) state.doc.nodesBetween(from, to, (n) => { found ||= n.isText && type.isInSet(n.marks); });
  return found ? found.attrs.color ?? found.attrs.bg : "";
}
