// ---------- 编辑区:Milkdown 富文本编辑器 ----------
// 看到的是排好版的样子(标题、粗体、列表、代码块……),存到文件里的还是普通的 Markdown。
// 每个页面有自己的编辑状态(内容、光标、撤销记录):换页时存进页面对象(n.state),换回来再放回编辑器,
// 所以换过页以后 Ctrl+Z 还能撤销之前打的字。
// n.content 是页面的 Markdown;n.stateMd 是 n.state 对应的 Markdown,两个不一样说明文件在别处被改过。
import {
  Editor,
  rootCtx,
  editorViewCtx,
  parserCtx,
  serializerCtx,
  remarkStringifyOptionsCtx,
  linkAttr,
  hardbreakSchema,
  commonmark,
  syncHeadingIdPlugin,
  gfm,
  history,
  clipboard,
  $prose,
  $remark,
  Plugin,
  PluginKey,
  Decoration,
  DecorationSet,
  TextSelection,
  EditorState,
  closeHistory,
  NodeSelection,
  wrapInList,
  sinkListItem,
  liftListItem,
  splitListItem,
} from "../vendor/milkdown.js";
import { $ } from "./dom.js";
import { codeBlockWithTitle, codeBlockView, codeHighlight, setCodeFoldPersistence, setLangMenu, setTitleColorButton } from "./codeblock.js";
import { blockManager, applyBlockSettings } from "./blocks.js";
import { foldBlocks, revealFolds, safeDocumentEnd, setFoldPersistence } from "./foldblocks.js";
import { formatBar, selectionBar, setFormatBarItems, setSelectionBar } from "./formatbar.js";
import { colorSpans, colorHandlers, textColor, textBg } from "./colors.js";
import { findPlugin, reapplyFind } from "./find.js";
import { outlinePlugin } from "./outline.js";
import { codeToText } from "./toolbar.js";
import { imagePlugin, applyImageSettings } from "./images.js";
import { findLocalPaths } from "./localpaths.js";
import { parseAccent } from "./accent.js";
import { pageLinkPlugin, applyPageLinkSettings } from "./pagelinkview.js";
import { expandPlugin, applyExpandSettings } from "./expand.js";

let editor = null;
let view = null;
let ctx = null;
// 编辑器里现在放着的页面
let shown = null;
// 用户改了内容时调用,参数是被改的页面
let onChange = () => {};
// 别处来的修改(换页、文件在别处被改过):不算用户的修改,不触发保存
const EXTERNAL = "minipad-external";

// 邮箱默认按普通文字显示，保留手动指定的 mailto 链接与网址自动识别。
let autoEmailLinks = false;
let pathSettings = { local_path_enabled: false };
let editorMobile = false;
let onLocalPath = () => {};
let onLocalPathMenu = () => {};

const localPathKey = new PluginKey("minipad-local-paths");
const missingLocalPaths = new Map();

// 通过 ProseMirror 的装饰事务更新，不直接改编辑器 DOM，避免触发重复解析。
// Android 只切换本地路径文字装饰，不运行桌面专用的设置面板逻辑。
export function setMobileLocalPathEnabled(enabled) {
  pathSettings.local_path_enabled = enabled === true;
  if (view) view.dispatch(view.state.tr.setMeta(localPathKey, true).setMeta("addToHistory", false));
}

// 一页里有很多路径时,检查结果是一个个回来的:攒一下再一起重画,不用每回来一个就把整页扫一遍
let pathRefresh = 0;
export function markLocalPathMissing(path, missing) {
  if (missingLocalPaths.get(path) === missing) return;
  missingLocalPaths.set(path, missing);
  if (!view || pathRefresh) return;
  pathRefresh = setTimeout(() => {
    pathRefresh = 0;
    view.dispatch(view.state.tr.setMeta(localPathKey, true).setMeta("addToHistory", false));
  }, 30);
}
const localPathDecorations = (doc, from = 0, to = doc.content.size) => {
  if (!pathSettings.local_path_enabled) return DecorationSet.empty;
  const decorations = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock || node.type.name === "code_block") return true;
    node.forEach((child, offset) => {
      if (!child.isText) return;
      for (const match of findLocalPaths(child.text)) {
        decorations.push(Decoration.inline(pos + 1 + offset + match.from, pos + 1 + offset + match.to, {
          class: pathSettings.local_path_missing !== false && missingLocalPaths.get(match.path) ? "local-file-path missing" : "local-file-path",
          "data-local-path": match.path,
        }));
      }
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
};
const localPathPlugin = $prose(() => new Plugin({
  key: localPathKey,
  state: {
    init: (_, state) => localPathDecorations(state.doc),
    apply(tr, old) {
      if (tr.getMeta(localPathKey)) return localPathDecorations(tr.doc);
      if (!tr.docChanged) return old;
      let mapped = old.map(tr.mapping, tr.doc);
      const blocks = new Map();
      tr.mapping.maps.forEach((stepMap, index) => {
        stepMap.forEach((_, __, newStart, newEnd) => {
          const remaining = tr.mapping.slice(index + 1);
          const from = Math.max(0, remaining.map(newStart) - 1);
          const to = Math.min(tr.doc.content.size, remaining.map(newEnd) + 1);
          tr.doc.nodesBetween(from, to, (node, pos) => {
            if (node.isTextblock && node.type.name !== "code_block") {
              blocks.set(pos, { from: pos, to: pos + node.nodeSize });
              return false;
            }
            return !node.type.spec.code;
          });
        });
      });
      for (const block of blocks.values()) {
        mapped = mapped.remove(mapped.find(block.from, block.to));
        mapped = mapped.add(tr.doc, localPathDecorations(tr.doc, block.from, block.to).find());
      }
      return mapped;
    },
  },
  props: {
    decorations: (state) => localPathKey.getState(state),
    handleDOMEvents: {
      click: (v, e) => {
        const el = e.target.closest?.("[data-local-path]");
        if (!el || !v.dom.contains(el) || !pathSettings.local_path_enabled) return false;
        if (pathSettings.local_path_click !== "click" && !(e.ctrlKey || e.metaKey)) return false;
        e.preventDefault();
        onLocalPath(el.dataset.localPath);
        return true;
      },
      contextmenu: (v, e) => {
        const el = e.target.closest?.("[data-local-path]");
        if (!el || !v.dom.contains(el) || !pathSettings.local_path_enabled) return false;
        e.preventDefault();
        onLocalPathMenu(el.dataset.localPath, e.clientX, e.clientY);
        return true;
      },
    },
  },
}));
let emailLinkVersion = 0;
// GFM 会把裸邮箱解析成 mailto 链接。对照原始 Markdown 的源码区间，仅还原
// 裸邮箱生成的链接，避免误伤 [标题](mailto:...) 或 <name@example.com>。
const plainEmails = $remark("plainEmails", () => () => (tree, file) => {
  if (autoEmailLinks) return;
  const markdown = String(file.value ?? "");
  const walk = (parent) => {
    if (!Array.isArray(parent.children)) return;
    parent.children = parent.children.map((child) => {
      const text = child.children?.length === 1 && child.children[0].type === "text"
        ? child.children[0].value : null;
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (child.type === "link" && typeof text === "string" &&
        child.url?.toLowerCase() === ("mailto:" + text).toLowerCase() &&
        Number.isInteger(start) && Number.isInteger(end) &&
        markdown.slice(start, end) === text) {
        return { type: "text", value: text, position: child.position };
      }
      walk(child);
      return child;
    });
  };
  walk(tree);
});
const parse = (md) => ctx.get(parserCtx)(md);
// 保留引用块的 [!fold] 识别标记，避免 remark-stringify 逃逸 '['。
const serialize = (doc) => ctx.get(serializerCtx)(doc);

// ---------- 用户的修改 ----------
// 每次文档变了,如果不是别处来的修改,就记下页面的 Markdown 已经过时(mdStale),通知保存。
// 整篇转回 Markdown 很慢(十几万字的页面要上百毫秒),所以不在每次按键时转,
// 等保存、换页、搜索这些要用 n.content 的时候再转(见 syncContent)
const changeKey = new PluginKey("minipad-change");
const changes = $prose(
  () =>
    new Plugin({
      key: changeKey,
      state: {
        init: () => false,
        apply: (tr, user) => (tr.docChanged ? !tr.getMeta(EXTERNAL) : user),
      },
      view: () => ({
        update(v, prev) {
          if (!shown || shown.unreadable || v.state.doc === prev.doc || !changeKey.getState(v.state)) return;
          shown.mdStale = true;
          onChange(shown);
        },
      }),
    }),
);

// 把编辑器里的文档转回 Markdown 存进页面(n.content)。只有编辑器里的页面改过以后才需要转;
// 转出来和原来一样(比如改了又改回去)就不算修改。返回内容有没有变
export function syncContent(n = shown) {
  if (!n || n !== shown || !n.mdStale) return false;
  n.mdStale = false;
  let md = serialize(view.state.doc);
  // 原来的文件末尾没有换行,存的时候也不加
  if (!n.stateMd.endsWith("\n")) md = md.replace(/\n$/, "");
  if (md === n.stateMd) return false;
  n.content = n.stateMd = md;
  return true;
}

// 读取失败的页面是只读的:除了键盘输入,F5 插入日期、点任务方框、格式栏这些修改也都不让改
const readOnly = $prose(
  () => new Plugin({ filterTransaction: (tr) => !tr.docChanged || !shown?.unreadable || !!tr.getMeta(EXTERNAL) }),
);

// ---------- 换行 ----------
// 文件里段落中间的一个换行,在编辑器里也显示成换行(和以前的阅读模式一样),存回去还是一个换行。
// Milkdown 默认把它显示成空格
const lineBreak = hardbreakSchema.extendSchema((prev) => (c) => {
  const base = prev(c);
  return { ...base, toDOM: (node) => ["br", { "data-type": "hardbreak", "data-is-inline": String(node.attrs.isInline) }] };
});

// Shift+Enter:段落里换行,不开新段落。存到文件里就是一个换行
function softBreak(state, dispatch) {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(state.schema.nodes.hardbreak.create({ isInline: true })).scrollIntoView());
  return true;
}

// ---------- 空白页面的提示文字 ----------
const placeholder = $prose(
  () =>
    new Plugin({
      props: {
        decorations(state) {
          const { doc } = state;
          const first = doc.firstChild;
          if (doc.childCount !== 1 || !first.isTextblock || first.content.size) return null;
          return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { class: "is-empty", "data-placeholder": "写点什么……" })]);
        },
      },
    }),
);

// ---------- 列表和任务 ----------
function listItemsIn(state) {
  const { from, to } = state.selection;
  const items = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "list_item") {
      // 只要最里层的:选区在子项里时不动外面那一项
      let inner = false;
      node.descendants((child, p) => {
        if (child.type.name === "list_item" && pos + 1 + p < to && pos + 1 + p + child.nodeSize > from) inner = true;
        return !inner;
      });
      if (!inner) items.push({ node, pos });
    }
    return true;
  });
  return items;
}

// Ctrl+Enter:勾选 / 取消勾选任务;列表项变成任务,普通的段落变成任务列表
export function toggleTask(state, dispatch) {
  const items = listItemsIn(state);
  if (items.length) {
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of items) {
        const checked = node.attrs.checked == null ? false : !node.attrs.checked;
        tr.setNodeMarkup(pos, null, { ...node.attrs, checked });
      }
      dispatch(tr);
    }
    return true;
  }
  const { bullet_list: list } = state.schema.nodes;
  let wrapped = null;
  if (!wrapInList(list)(state, (tr) => (wrapped = tr))) return false;
  if (dispatch) {
    const after = state.apply(wrapped);
    const tr = wrapped;
    for (const { node, pos } of listItemsIn(after)) tr.setNodeMarkup(pos, null, { ...node.attrs, checked: false });
    dispatch(tr);
  }
  return true;
}

// 点任务前面的方框(列表项左边的空白)勾选 / 取消勾选
function clickTask(v, e) {
  // 方框画在列表项左边的空白里,点到的可能是列表本身(ul),这时按高度找是哪一项
  let li = e.target.closest?.('li[data-item-type="task"]');
  if (!li && e.target.matches?.("ul, ol")) {
    li = [...e.target.children].find((c) => {
      const r = c.getBoundingClientRect();
      return c.dataset.itemType === "task" && e.clientY >= r.top && e.clientY <= r.bottom;
    });
  }
  if (!li || !v.dom.contains(li)) return false;
  const text = li.firstElementChild;
  if (!text || e.clientX >= text.getBoundingClientRect().left) return false;
  const pos = v.posAtDOM(li, 0) - 1;
  const node = v.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "list_item") return false;
  e.preventDefault();
  v.dispatch(v.state.tr.setNodeMarkup(pos, null, { ...node.attrs, checked: !node.attrs.checked }));
  return true;
}

// 代码块里 Tab 插入制表符,列表里 Tab 缩进一级;其他地方的 Tab 什么也不做,但不让焦点跑出编辑区
function tab(state, dispatch) {
  const { $from } = state.selection;
  if ($from.parent.type.spec.code) {
    if (dispatch) dispatch(state.tr.insertText("\t").scrollIntoView());
    return true;
  }
  sinkListItem(state.schema.nodes.list_item)(state, dispatch);
  return true;
}
function untab(state, dispatch) {
  liftListItem(state.schema.nodes.list_item)(state, dispatch);
  return true;
}

// 在任务后面按 Enter:新的一项是没勾选的任务(Milkdown 默认会照抄上一项的勾)
function enterInTask(state, dispatch) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth < 2) return false;
  const item = $from.node(-1);
  if (item.type.name !== "list_item" || item.attrs.checked == null || !$from.parent.content.size) return false;
  return splitListItem(item.type, { ...item.attrs, checked: false })(state, dispatch);
}

// 代码块最后一行留空后再按 Enter,从代码块退出到普通段落。
// Ctrl+Enter 可以在代码块的任意位置直接退出,不影响其它地方的任务快捷键。
let codeExitMode = "blank3";
function exitCodeBlock(state, dispatch, afterBlank = false) {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.type.spec.code) return false;
  const count = codeExitMode === "blank2" ? 1 : 2;
  if (afterBlank && (codeExitMode === "ctrl" || $from.parentOffset !== $from.parent.content.size ||
    !$from.parent.textContent.endsWith("\n".repeat(count)))) return false;
  if (dispatch) {
    const tr = state.tr;
    const end = $from.after();
    // 退出时删除专门用于退出的末尾空行，保留代码中间的空白行。
    const remove = afterBlank ? (codeExitMode === "blank2" ? 1 : 2) : 0;
    if (remove) tr.delete($from.pos - remove, $from.pos);
    const at = end - remove;
    tr.insert(at, state.schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView());
  }
  return true;
}

// 在最后一个代码块(或表格)的最后一行按 ↓:后面补一个空段落,好接着往下写
function downOutOfBlock(state, dispatch) {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const block = $from.node(1);
  const last = state.doc.lastChild;
  if (!block || block !== last || !(block.type.spec.code || block.type.name === "table")) return false;
  if (block.type.spec.code && $from.parent.textContent.indexOf("\n", $from.parentOffset) !== -1) return false;
  if (dispatch) {
    const end = state.doc.content.size;
    const tr = state.tr.insert(end, state.schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView());
  }
  return true;
}

// 打 --- 变成分隔线以后,光标放到分隔线下面的段落里(不然接着打字会把分隔线替换掉)
const afterRule = $prose(
  () =>
    new Plugin({
      appendTransaction(trs, old, state) {
        const sel = state.selection;
        if (!trs.some((tr) => tr.docChanged) || !(sel instanceof NodeSelection) || sel.node.type.name !== "hr") return null;
        const tr = state.tr;
        let after = sel.to;
        if (!state.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, state.schema.nodes.paragraph.create());
        return tr.setSelection(TextSelection.create(tr.doc, after + 1));
      },
    }),
);

// 链接:Ctrl+点击用系统浏览器打开
let openLink = () => {};
function clickLink(v, e) {
  if (!(e.ctrlKey || e.metaKey)) return false;
  const a = e.target.closest?.("a[href]");
  if (!a || !v.dom.contains(a)) return false;
  e.preventDefault();
  openLink(a.getAttribute("href"));
  return true;
}

// 回退 Markdown 代码围栏输入规则时，不保留触发规则的 Enter 换行。
function undoCodeRule(state, dispatch) {
  const undoable = state.plugins.find((p) => p.spec.isInputRules)?.getState(state);
  if (!undoable || undoable.text !== "\n") return false;
  if (dispatch) {
    const tr = state.tr;
    const steps = undoable.transform.steps;
    for (let i = steps.length - 1; i >= 0; i--) tr.step(steps[i].invert(undoable.transform.docs[i]));
    dispatch(tr);
  }
  return true;
}

// 页首空代码块可以退格回到正文，避免只能依赖格式栏解除。
function removeEmptyFirstCode(state, dispatch) {
  const { $from, empty } = state.selection;
  if (!empty || $from.depth !== 1 || $from.before() !== 0 ||
    !$from.parent.type.spec.code || $from.parent.content.size) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith(0, $from.parent.nodeSize, state.schema.nodes.paragraph.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, 1)));
  }
  return true;
}

// Ctrl+A:光标在代码块里时先只选中这个代码块的内容;已经全选了,再按才选整页
function selectCodeBlock(state, dispatch) {
  const { $from, $to } = state.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return false;
  const from = $from.start();
  const to = $from.end();
  if ($from.pos === from && $to.pos === to) return false;
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  return true;
}

// Ctrl+B:选中了文字就加粗;没选中时留给窗口(打开笔记本列表)
let emptyBold = () => {};

const keys = $prose(
  () =>
    new Plugin({
      props: {
        handleKeyDown(v, e) {
          if (e.isComposing || e.keyCode === 229) return false;
          if (e.key === "Tab" || e.key === "Enter" || e.key === "ArrowDown" || e.key.toLowerCase() === "b" ||
              ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a")) readSelection(v);
          const mod = e.ctrlKey || e.metaKey;
          // 编辑器里明确处理 Ctrl+End，避免换页后浏览器原生选区偶尔跳到段落开头。
          if (mod && e.key === "End" && !e.shiftKey && !e.altKey) {
            v.dispatch(safeDocumentEnd(v));
            e.preventDefault();
            return true;
          }
          let run = null;
          if (e.key === "Tab" && !mod && !e.altKey) run = e.shiftKey ? untab : tab;
          else if (e.key === "Enter" && mod && !e.shiftKey && !e.altKey) run = (state, dispatch) =>
            exitCodeBlock(state, dispatch) || toggleTask(state, dispatch);
          else if (e.key === "Enter" && e.shiftKey && !mod && !e.altKey) run = softBreak;
          else if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) run = (state, dispatch) =>
            exitCodeBlock(state, dispatch, true) || enterInTask(state, dispatch);
          else if (e.key === "ArrowDown" && !e.shiftKey && !mod && !e.altKey) run = downOutOfBlock;
          else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") run = selectCodeBlock;
          else if (mod && e.altKey && !e.shiftKey && e.key === "0") run = codeToText;
          else if (e.key === "Backspace" && !mod && !e.altKey && !e.shiftKey) run = (state, dispatch) =>
            undoCodeRule(state, dispatch) || removeEmptyFirstCode(state, dispatch);
          else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b" && v.state.selection.empty) {
            e.preventDefault();
            emptyBold();
            return true;
          }
          if (!run || !run(v.state, v.dispatch)) return false;
          e.preventDefault();
          return true;
        },
        handleDOMEvents: {
          mousedown: (v, e) => e.button === 0 && clickTask(v, e),
          click: (v, e) => clickLink(v, e),
        },
      },
    }),
);

// 刚点过鼠标、马上按键时,编辑器可能还没读到新的光标位置(浏览器稍后才通知);先读一下
function readSelection(v) {
  try {
    v.domObserver?.flush();
  } catch (_) {}
}

// 文字写进文件时怎么转义。Milkdown 自带的写法把「以空白结尾的文字」原样写出、不转义,
// 行首只有空白的一段(比如几个空格后面紧跟带颜色的字)也原样写出,下次打开时就被吃掉了。
// 这里:只有空白的一段在行首时把第一个写成字符引用;以空白结尾的,空白前面的部分照常转义
function unescapePlainEmail(markdown) {
  // GFM 会把文字节点里的邮箱 @ 转义成 \@，但我们自己的解析器已能区分
  // 裸邮箱与显式 mailto 链接，所以无需为防止自动链接而额外转义。
  return autoEmailLinks ? markdown :
    markdown.replace(/([A-Za-z0-9._%+-]+)\\@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1@$2");
}

// 页面链接 [[名字]] 原样写回(0.5.0):Markdown 默认把 [ 都转义,会写成 \[\[名字]]。名字里别的转义(\_ 这些)照留
const keepPageLinks = (markdown) => markdown.replace(/\\\[\\\[((?:\\[^\[\]\n]|[^\\\[\]\n])+)\]\]/g, "[[$1]]");

function writeText(node, parent, state, info) {
  const v = node.value;
  // 只在引用块内的标记段保留 [!fold] 原文，避免触碰代码块中的反斜杠。
  if (/^\[!fold\][+-](?: |$)/.test(v) && parent?.type === "paragraph" &&
      parent.children?.[0] === node && state.stack?.includes("blockquote")) {
    return "[!fold]" + v[7] + (v.length > 8 ? " " + state.safe(v.slice(9), { ...info, encode: [] }) : "");
  }
  if (/^[ \t]+$/.test(v)) return /[\r\n]$/.test(info.before ?? "") ? (v[0] === "\t" ? "&#x9;" : "&#x20;") + v.slice(1) : v;
  const tail = /[ \t]+$/.exec(v);
  if (!tail) return keepPageLinks(unescapePlainEmail(state.safe(v, { ...info, encode: [] })));
  return keepPageLinks(unescapePlainEmail(state.safe(v.slice(0, tail.index), { ...info, after: tail[0][0], encode: [] }))) + tail[0];
}

// ---------- 编辑器 ----------
export async function createEditor(opts) {
  onChange = opts.onChange;
  openLink = opts.openLink;
  onLocalPath = opts.openLocalPath || (() => {});
  onLocalPathMenu = opts.localPathMenu || (() => {});
  emptyBold = opts.emptyBold;
  const mobile = opts.mobile === true;
  editorMobile = mobile;
  editor = await Editor.make()
    .config((c) => {
      c.set(rootCtx, $("#editor"));
      // 写回文件时:列表用 -,分隔线用 ---
      // 字体颜色、背景颜色写成 <span style>(见 colors.js)
      c.update(remarkStringifyOptionsCtx, (o) => ({ ...o, bullet: "-", rule: "-", handlers: { ...o.handlers, text: writeText, ...colorHandlers } }));
      c.set(linkAttr.key, () => ({ title: "Ctrl+点击打开链接" }));
    })
    // 页面链接的补全列表开着时,上下键、回车、Tab、Esc 归它;片段和行内计算要先看 Tab;
    // 然后是自己的按键,先于 Milkdown 自带的按键处理(Shift+Enter、Ctrl+B 等)
    .use(pageLinkPlugin)
    .use(expandPlugin)
    .use(keys)
    // 不要 Milkdown 给标题算 id 的插件:没有地方用到标题的 id(大纲、跳转都按位置),
    // 它却在每次打开页面、每次打字时把整页的标题过一遍,打开页面时还要多改一次文档
    .use(commonmark.filter((p) => p !== syncHeadingIdPlugin))
    .use(gfm)
    .use(plainEmails)
    .use(localPathPlugin)
    .use(history)
    .use(clipboard)
    .use([colorSpans, textColor, textBg].flat())
    // Mobile shares the exact desktop Markdown schema and document commands.
    // Only mouse/window-specific plugins are replaced or left off on Android.
    .use(mobile
      ? [lineBreak, codeBlockWithTitle, codeBlockView, codeHighlight, readOnly, changes, placeholder, afterRule, selectionBar, formatBar, foldBlocks, blockManager, opts.mobileImagePlugin]
      : [lineBreak, codeBlockWithTitle, codeBlockView, codeHighlight, readOnly, changes, placeholder, afterRule, findPlugin, outlinePlugin, selectionBar, formatBar, foldBlocks, blockManager, imagePlugin])
    .create();
  editor.action((c) => {
    ctx = c;
    view = c.get(editorViewCtx);
  });
  view.dom.setAttribute("aria-label", "页面内容");
  view.dom.spellcheck = false;
  watchLongPageWidth();
}

export function editorView() {
  return view;
}

// 测试用:当前页面的 Markdown、纯文字和选中的文字
export function editorDebug() {
  return {
    view,
    markdown: () => serialize(view.state.doc),
    text: () => view.state.doc.textBetween(0, view.state.doc.content.size, "\n"),
    selection: () => editorSelectionText(),
  };
}

function scroller() {
  return $("#editor");
}

// ---------- 长页面 ----------
// 很长的页面只排版看得见的那几屏(CSS 的 content-visibility,见 style.css 的 data-long-page):
// 十几万字、几十个代码块的页面,每打一个字浏览器都要把整页重新排一遍,很慢。
// 先照常完整排版一次(这时浏览器记下每一段的真实高度),下一帧才开始跳过看不见的部分,
// 所以滚动条、换页回来的滚动位置、目录跳转都和以前一样准。窗口宽度变了重来一次。设置 → 编辑 里可以关掉
const LONG_PAGE = 20000;
let lazyLongPages = true;
let lazyFrame = 0;
export function setLazyLongPages(on) {
  lazyLongPages = on !== false;
  if (view) markLongPage();
}
function markLongPage() {
  const box = scroller();
  cancelAnimationFrame(lazyFrame);
  if (!lazyLongPages || !shown || view.state.doc.content.size <= LONG_PAGE) {
    box.removeAttribute("data-long-page");
    return;
  }
  box.dataset.longPage = "";
  lazyFrame = requestAnimationFrame(() => {
    lazyFrame = requestAnimationFrame(() => {
      if (box.hasAttribute("data-long-page")) box.dataset.longPage = "lazy";
    });
  });
}
// 宽度变了,没排版的那些段落记下的高度就不对了
let lazyWidth = 0;
function watchLongPageWidth() {
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width !== lazyWidth && lazyWidth && scroller().hasAttribute("data-long-page")) markLongPage();
    lazyWidth = width;
  }).observe(scroller());
}

// 把编辑器里的页面的状态、内容和滚动位置存回页面对象
function keep() {
  if (!shown) return;
  syncContent(shown);
  shown.state = view.state;
  shown.scroll = scroller().scrollTop;
}

// 状态栏的字数:编辑器里看得到的字,不算 Markdown 的符号和换行(一个 emoji 算一个字)
export function visibleLength() {
  const text = view.state.doc.textContent;
  return text.length - (text.match(/[\uD800-\uDBFF]/g)?.length ?? 0);
}

function freshState(md) {
  return EditorState.create({ schema: view.state.schema, doc: parse(md), plugins: view.state.plugins });
}

// 把文档换成 md 的内容:只换掉不一样的部分,光标和滚动位置不会乱跳;撤销记录里单独算一步
function replaceTr(state, md) {
  const doc = parse(md);
  const tr = state.tr.setMeta(EXTERNAL, true);
  const start = state.doc.content.findDiffStart(doc.content);
  if (start == null) return null;
  let { a: endA, b: endB } = state.doc.content.findDiffEnd(doc.content);
  // 两边重叠时往后挪,保证 start ≤ end
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  closeHistory(tr);
  tr.replace(start, endA, doc.slice(start, endB));
  return tr;
}

// 换页时调用:放上 n 的状态,内容在别处变过就先换成新内容
export function showInEditor(n) {
  if (shown === n) {
    setEditorText(n);
    return;
  }
  keep();
  shown = null;
  if (n.unreadable) n.state = null;
  let st = n.unreadable ? null : n.state;
  let scroll = n.scroll || 0;
  if (!st) {
    st = freshState(n.content);
    n.stateMd = n.content;
  } else if (n.stateMd !== n.content || n.emailLinkVersion !== emailLinkVersion) {
    const changed = n.stateMd !== n.content;
    const tr = replaceTr(st, n.content);
    if (tr) st = st.apply(changed ? tr : tr.setMeta("addToHistory", false));
    n.stateMd = n.content;
    if (changed) scroll = 0;
  }
  n.emailLinkVersion = emailLinkVersion;
  view.updateState(st);
  shown = n;
  markLongPage();
  view.setProps({ editable: () => !shown?.unreadable && !shown?.mini });
  // 查找栏开着时,换过来的页面也按同样的条件高亮
  reapplyFind(view);
  scroller().scrollTop = scroll;
}

// 编辑器里的页面的内容在别处变了(n.content 已经是新内容):换上新内容,可以撤销回去
export function setEditorText(n) {
  if (n !== shown) return;
  view.setProps({ editable: () => !shown?.unreadable && !shown?.mini });
  if (n.unreadable) {
    n.state = null;
    return;
  }
  if (n.stateMd === n.content) return;
  const tr = replaceTr(view.state, n.content);
  n.stateMd = n.content;
  if (tr) view.dispatch(tr);
  markLongPage();
}

// 记下当前位置
export function leaveEditor() {
  keep();
}

export function focusEditorView() {
  if (!shown?.unreadable && !shown?.mini) view.focus();
}

export function editorSelectionText() {
  const { from, to } = view.state.selection;
  return view.state.doc.textBetween(from, to, "\n");
}

export function editorIsComposing() { return !!view?.composing; }

// 选中文档里第 nth 个 query(不分大小写),找不到就选第一个;滚到窗口中间
export function selectMatch(query, nth = 0) {
  const q = query.toLowerCase();
  if (!q) return;
  const found = [];
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // 这一段的文字和每个字在文档里的位置
    let text = "";
    const at = [];
    node.forEach((child, offset) => {
      const s = child.isText ? child.text : child.type.name === "hardbreak" ? "\n" : "￼";
      for (let i = 0; i < s.length; i++) at.push(pos + 1 + offset + (child.isText ? i : 0));
      text += s;
    });
    const low = text.toLowerCase();
    for (let i = low.indexOf(q); i !== -1; i = low.indexOf(q, i + 1)) found.push([at[i], at[i + q.length - 1] + 1]);
    return false;
  });
  const hit = found[nth] || found[0];
  if (!hit) return;
  const { state } = view;
  revealFolds(view, hit[0]);
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, hit[0], hit[1])));
  view.focus();
  // 滚到窗口中间
  const box = scroller();
  const c = view.coordsAtPos(hit[0]);
  const r = box.getBoundingClientRect();
  box.scrollTop += c.top - r.top - box.clientHeight / 2;
}

// 在光标处插入文字(替换选中的部分)
export function insertText(text) {
  readSelection(view);
  view.dispatch(view.state.tr.insertText(text).scrollIntoView());
  view.focus();
}

export function applyEditorSettings(s) {
  const oldPath = JSON.stringify(pathSettings);
  pathSettings = {
    local_path_enabled: editorMobile ? s.local_path_enabled === true : s.local_path_enabled !== false,
    local_path_click: s.local_path_click,
    local_path_underline: s.local_path_underline || "dashed",
    local_path_color: s.local_path_color || "",
    local_path_missing: s.local_path_missing !== false,
  };
  const root = $("#editor");
  root.dataset.localPathUnderline = pathSettings.local_path_underline;
  const pathColor = parseAccent(pathSettings.local_path_color);
  root.style.setProperty("--local-path-color", pathColor?.from || "var(--accent)");
  root.style.setProperty("--local-path-gradient", pathColor?.to ? pathSettings.local_path_color : "none");
  root.toggleAttribute("data-local-path-gradient", !!pathColor?.to);
  if (view && oldPath !== JSON.stringify(pathSettings)) {
    view.dispatch(view.state.tr.setMeta(localPathKey, true).setMeta("addToHistory", false));
  }
  const wasEnabled = autoEmailLinks;
  autoEmailLinks = s.email_auto_link === true;
  // 切换选项时重新读取当前 Markdown，仅更新编辑器状态，不当作一次编辑保存。
  if (wasEnabled !== autoEmailLinks) {
    emailLinkVersion++;
    if (view && shown) {
      syncContent(shown);
      const tr = replaceTr(view.state, shown.content);
      if (tr) view.dispatch(tr.setMeta("addToHistory", false));
      shown.emailLinkVersion = emailLinkVersion;
    }
  }
  setLazyLongPages(s.long_page_lazy);
  applyPageLinkSettings(s);
  applyExpandSettings(s);
  codeExitMode = ["blank2", "blank3", "ctrl"].includes(s.code_exit_mode) ? s.code_exit_mode : "blank3";
  setFoldPersistence(s.fold_save_state !== false);
  setCodeFoldPersistence(s.fold_save_state !== false);
  setLangMenu(s.code_lang_menu !== false);
  setTitleColorButton(s.code_title_color !== false);
  applyBlockSettings(s);
  applyImageSettings(s);
  $("#editor").classList.toggle("code-lines", s.code_line_numbers !== false);
  const bar = s.format_bar !== false;
  $("#format-bar").hidden = !bar;
  setFormatBarItems(s.format_bar_hidden, s.format_bar_order);
  setSelectionBar(s);
  $("#btn-format").classList.toggle("on", bar);
  $("#btn-format").setAttribute("aria-pressed", String(bar));
}
