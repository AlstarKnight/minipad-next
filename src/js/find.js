// ---------- 页面内查找和替换:找出当前页面里所有匹配的地方,高亮显示 ----------
// 一段一段地找(段落、标题、列表里的一段、代码块……):段落里的换行(Shift+Enter)算 "\n",
// 图片这类不是文字的东西算一个 "￼",跨过它的匹配不算。可以区分大小写、全字匹配、用正则表达式。
// 这里不引用 editor.js(editor.js 要用这里的插件),对编辑器的操作都通过传进来的 view。
import { $prose, Plugin, PluginKey, Decoration, DecorationSet, TextSelection, closeHistory } from "../vendor/milkdown.js";
import { revealFolds } from "./foldblocks.js";

const OBJECT = "￼";
// 匹配太多时只算前面这些,免得卡住
export const MAX_MATCHES = 5000;
const key = new PluginKey("minipad-find");
const EMPTY = { opts: null, matches: [], current: -1, error: null, deco: DecorationSet.empty };

// 查找栏开着时的条件:{ query, caseSensitive, wholeWord, regex };关着是 null。换页时用它重新高亮
let active = null;
// 匹配或当前项变了时通知查找栏(更新「3/12」)
let listener = () => {};
export function onFindChange(fn) {
  listener = fn;
}

// 全字匹配用:字母、数字、下划线算单词的一部分;汉字、假名、谚文不算(中文不用空格分词)
const WORD = /[\p{L}\p{N}_]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const isWord = (ch) => !!ch && WORD.test(ch) && !CJK.test(ch);

// 查找条件变成正则表达式;写错的正则返回 { error }
function compile(opts) {
  if (!opts?.query) return null;
  const source = opts.regex ? opts.query : opts.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return { re: new RegExp(source, opts.caseSensitive ? "gm" : "gim") };
  } catch (e) {
    return { error: "正则表达式有误:" + e.message };
  }
}

// 和 \b 一样:匹配的两头要么挨着非单词字符,要么匹配本身在那一头就不是单词字符
function wholeWordAt(text, s, e) {
  const left = s === 0 || !isWord(text[s - 1]) || !isWord(text[s]);
  const right = e === text.length || !isWord(text[e]) || !isWord(text[e - 1]);
  return left && right;
}

// 文档里所有匹配:[{ from, to, m }],m 是正则的匹配结果(替换时展开 $1 这些用)
export function findMatches(doc, opts) {
  const c = compile(opts);
  if (!c || c.error) return { matches: [], error: c?.error ?? null };
  const { re } = c;
  const matches = [];
  doc.descendants((node, pos) => {
    if (matches.length >= MAX_MATCHES) return false;
    if (!node.isTextblock) return true;
    // 这一段的文字,和每个字在文档里的位置(最后多一个:段落结尾)
    let text = "";
    const at = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        for (let i = 0; i < child.text.length; i++) at.push(start + i);
        text += child.text;
      } else {
        at.push(start);
        text += child.type.name === "hardbreak" ? "\n" : OBJECT;
      }
    });
    at.push(pos + 1 + node.content.size);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const s = m.index;
      const e = s + m[0].length;
      // 空的匹配(比如正则 a*)跳过,往后挪一个字接着找
      if (e === s) {
        re.lastIndex = s + 1;
        continue;
      }
      if (m[0].includes(OBJECT) || (opts.wholeWord && !wholeWordAt(text, s, e))) {
        re.lastIndex = s + 1;
        continue;
      }
      matches.push({ from: at[s], to: at[e - 1] + 1, m });
      if (matches.length >= MAX_MATCHES) break;
    }
    return false;
  });
  return { matches, error: null };
}

function decorate(doc, matches, current) {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((x, i) => Decoration.inline(x.from, x.to, { class: i === current ? "find-hit find-current" : "find-hit" })),
  );
}

// 插件:记着查找条件、匹配和当前是第几个;文档变了重新找,并把匹配高亮出来
export const findPlugin = $prose(
  () =>
    new Plugin({
      key,
      state: {
        init: () => EMPTY,
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(key);
          if (!meta && !tr.docChanged && !tr.selectionSet) return prev;
          const opts = meta && "opts" in meta ? meta.opts : prev.opts;
          if (!opts?.query) return { ...EMPTY, opts };
          let { matches, error } = prev;
          if ((meta && "opts" in meta) || tr.docChanged) ({ matches, error } = findMatches(state.doc, opts));
          let current;
          if (meta && "current" in meta) current = meta.current;
          else if (tr.docChanged && prev.current >= 0 && prev.matches[prev.current]) {
            // 改了别处:当前这个跟着挪;改的正是它,它就不算当前的了
            const was = prev.matches[prev.current];
            const from = tr.mapping.map(was.from);
            current = matches.findIndex((x) => x.from === from && x.to - x.from === was.to - was.from);
          } else if (tr.selectionSet) {
            // 光标挪了:选中的正好是一个匹配,它就是当前的
            const { from, to } = state.selection;
            current = matches.findIndex((x) => x.from === from && x.to === to);
          } else current = prev.current;
          if (current >= matches.length) current = -1;
          return { opts, matches, current, error, deco: decorate(state.doc, matches, current) };
        },
      },
      props: {
        decorations: (state) => key.getState(state)?.deco ?? null,
      },
      view: () => ({
        update(view, prev) {
          if (key.getState(view.state) !== key.getState(prev)) listener(view);
        },
      }),
    }),
);

export function findState(view) {
  return key.getState(view.state) ?? EMPTY;
}

// 选中第 i 个匹配,滚到能看见的地方(查找框保留焦点,编辑区里看不见选区,靠 find-current 的高亮)
function select(view, i) {
  const st = findState(view);
  const hit = st.matches[i];
  if (!hit) return;
  revealFolds(view, hit.from);
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, hit.from, hit.to)).setMeta(key, { current: i });
  view.dispatch(tr.scrollIntoView());
  // 滚到中间附近,上下文更清楚
  const box = view.dom.closest("#editor");
  if (box) {
    const c = view.coordsAtPos(hit.from);
    const r = box.getBoundingClientRect();
    if (c.top < r.top + 24 || c.bottom > r.bottom - 24) box.scrollTop += c.top - r.top - box.clientHeight / 3;
  }
}

// 换了查找条件:重新找;select 时选中从 origin(没给就是光标)开始往后的第一个
export function setFind(view, opts, { select: pick = false, origin = null } = {}) {
  active = opts?.query ? { ...opts } : null;
  view.dispatch(view.state.tr.setMeta(key, { opts: active, current: -1 }));
  if (!pick) return;
  const { matches } = findState(view);
  if (!matches.length) return;
  const at = origin ?? view.state.selection.from;
  const i = matches.findIndex((x) => x.from >= at);
  select(view, i >= 0 ? i : 0);
}

// 换页以后(编辑器换了一个状态):按查找栏现在的条件重新高亮。
// 这一页上次就是按这个条件找的,结果还在,只要让查找栏重新显示「3/12」
// (换状态时插件的 view 是重新建的,不会通知查找栏)
export function reapplyFind(view) {
  if (findState(view).opts !== active) view.dispatch(view.state.tr.setMeta(key, { opts: active, current: -1 }));
  else listener(view);
}

// 下一个(dir = 1)/ 上一个(dir = -1),到头了从另一头接着来
export function findNext(view, dir = 1) {
  const st = findState(view);
  const n = st.matches.length;
  if (!n) return false;
  let i;
  if (st.current >= 0) i = (st.current + dir + n) % n;
  else {
    const { from } = view.state.selection;
    if (dir > 0) {
      i = st.matches.findIndex((x) => x.from >= from);
      if (i < 0) i = 0;
    } else {
      i = st.matches.findLastIndex((x) => x.from < from);
      if (i < 0) i = n - 1;
    }
  }
  select(view, i);
  return true;
}

// 替换的文字:正则模式下 $& $1 $<名字> $$ 换成匹配到的内容,\n \t 是换行和 Tab;普通模式原样
export function expandReplacement(text, m, regex) {
  if (!regex) return text;
  return text
    .replace(/\\(\\|n|t)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"))
    .replace(/\$(\$|&|<([^>]*)>|(\d{1,2}))/g, (all, what, name, num) => {
      if (what === "$") return "$";
      if (what === "&") return m[0];
      if (name !== undefined) return m.groups && name in m.groups ? (m.groups[name] ?? "") : all;
      const two = Number(num);
      if (two >= 1 && two < m.length) return m[two] ?? "";
      const one = Number(num[0]);
      if (num.length === 2 && one >= 1 && one < m.length) return (m[one] ?? "") + num[1];
      return all;
    });
}

// 把 from..to 换成 text:保留原来文字的格式;不在代码块里时 text 里的换行变成段落里的换行
function replaceRange(tr, from, to, text) {
  const $from = tr.doc.resolve(from);
  if ($from.parent.type.spec.code || !text.includes("\n")) {
    if (text) tr.insertText(text, from, to);
    else tr.delete(from, to);
    return;
  }
  const { schema } = tr.doc.type;
  const marks = $from.marksAcross(tr.doc.resolve(to)) ?? [];
  const nodes = [];
  text.split("\n").forEach((part, i) => {
    if (i) nodes.push(schema.nodes.hardbreak.create({ isInline: true }));
    if (part) nodes.push(schema.text(part, marks));
  });
  tr.replaceWith(from, to, nodes);
}

// 替换当前这个,再选中下一个;没有当前的就先选中下一个。返回替换了没有
export function replaceCurrent(view, replacement) {
  const st = findState(view);
  if (!view.editable || !st.matches.length) return false;
  if (st.current < 0) {
    findNext(view, 1);
    return false;
  }
  const hit = st.matches[st.current];
  const text = expandReplacement(replacement, hit.m, st.opts.regex);
  const tr = view.state.tr;
  closeHistory(tr);
  replaceRange(tr, hit.from, hit.to, text);
  const after = tr.mapping.map(hit.to);
  view.dispatch(tr.setMeta(key, { current: -1 }));
  // 接着找替换后的文字后面的下一个(替换成的文字本身也匹配时不会原地打转)
  const next = findState(view).matches;
  if (!next.length) return true;
  const i = next.findIndex((x) => x.from >= after);
  select(view, i >= 0 ? i : 0);
  return true;
}

// 全部替换,算一步(撤销一次就全回来);返回替换了几处
export function replaceAll(view, replacement) {
  const st = findState(view);
  if (!view.editable || !st.matches.length) return 0;
  const tr = view.state.tr;
  closeHistory(tr);
  for (let i = st.matches.length - 1; i >= 0; i--) {
    const hit = st.matches[i];
    replaceRange(tr, hit.from, hit.to, expandReplacement(replacement, hit.m, st.opts.regex));
  }
  view.dispatch(tr.setMeta(key, { current: -1 }).scrollIntoView());
  return st.matches.length;
}
