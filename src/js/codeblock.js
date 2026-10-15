// ---------- 编辑区里的代码块 ----------
// 代码块是一张卡片:顶栏左边是折叠按钮和标题,右边是语言和复制按钮,标题和语言点一下就能改;
// 下面是代码,带语法高亮和行号(行号可以在设置里关掉),长行自动换行。
// 文件里还是普通的 Markdown:```js 牛奶测试,``` 后面第一个词是语言,其余的是标题。
import { codeBlockSchema, $prose, Plugin, PluginKey, Decoration, DecorationSet, TextSelection } from "../vendor/milkdown.js";

// 第一个词是认识的语言或者像个语言名(字母、数字和 # + . -)才算语言
function looksLikeLanguage(word) {
  return !!word && (!!hljs.getLanguage(word) || /^[\w#+.-]+$/.test(word));
}

// remark 把 ``` 后面那一行拆成 lang(第一个词)和 meta(其余的);第一个词不像语言时整行都是标题
export function splitInfo(lang, meta) {
  lang = (lang || "").trim();
  meta = (meta || "").trim();
  if (!lang) return { language: "", title: meta };
  if (looksLikeLanguage(lang)) return { language: lang, title: meta };
  return { language: "", title: meta ? `${lang} ${meta}` : lang };
}

// 反过来:写回文件时的 lang 和 meta。没有语言、标题的第一个词又像语言时,前面补一个 text,
// 不然下次打开时标题的第一个词会被当成语言
export function joinInfo(language, title) {
  language = (language || "").trim();
  title = (title || "").trim();
  if (language) return { lang: language, meta: title || null };
  if (!title) return { lang: null, meta: null };
  const [first, ...rest] = title.split(/\s+/);
  if (looksLikeLanguage(first)) return { lang: "text", meta: title };
  return { lang: first, meta: rest.join(" ") || null };
}

// ``` 开头的那一行里不能有反引号,换行也不行
const cleanInfo = (s) => s.replace(/[`\r\n]+/g, " ").replace(/\s+/g, " ").trim();

// 代码块多一个 title 属性,读写 Markdown 时和 ``` 后面那一行对应
export const codeBlockWithTitle = codeBlockSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx);
  return {
    ...base,
    attrs: { ...base.attrs, title: { default: "", validate: "string" } },
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        const { language, title } = splitInfo(node.lang, node.meta);
        state.openNode(type, { language, title });
        if (node.value) state.addText(node.value);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        state.addNode("code", undefined, node.content.firstChild?.text || "", joinInfo(node.attrs.language, node.attrs.title));
      },
    },
  };
});

// ---------- 卡片 ----------
const ICON_COPY = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
const ICON_FOLD = '<svg viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';

const lineCount = (node) => node.textContent.split("\n").length;

class CodeBlockView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("div");
    this.dom.className = "codeblock";
    const head = (this.head = document.createElement("div"));
    head.className = "cb-head";
    head.contentEditable = "false";

    this.toggle = document.createElement("button");
    this.toggle.className = "cb-toggle";
    this.toggle.title = "折叠 / 展开";
    this.toggle.setAttribute("aria-expanded", "true");
    this.toggle.innerHTML = ICON_FOLD;
    this.toggle.addEventListener("click", () => this.setFolded(!this.dom.classList.contains("folded")));

    this.title = this.field("cb-title", "添加标题", "title", "代码块标题");
    this.count = document.createElement("span");
    this.count.className = "cb-count";
    this.lang = this.field("cb-lang", "语言", "language", "代码的语言,比如 js、python");

    this.copy = document.createElement("button");
    this.copy.className = "copy";
    this.copy.title = "复制代码";
    this.copy.innerHTML = ICON_COPY;
    this.copy.addEventListener("click", () => this.copyCode());

    head.append(this.toggle, this.title, this.count, this.lang, this.copy);
    const pre = (this.pre = document.createElement("pre"));
    // 行号放在代码左边单独的一栏里,按每一行在屏幕上的位置摆(长行换行以后行号对着这一行的开头)
    this.gutter = document.createElement("div");
    this.gutter.className = "cb-gutter";
    this.gutter.contentEditable = "false";
    this.contentDOM = document.createElement("code");
    pre.append(this.gutter, this.contentDOM);
    this.dom.append(head, pre);
    this.dom.addEventListener("click", (e) => {
      if (this.node.attrs.language === "copy" && !view.editable && !e.target.closest("button,input")) this.copyCode();
    });
    this.resize = new ResizeObserver(() => this.layoutLines());
    this.resize.observe(this.contentDOM);
    this.sync();
  }

  // 量出每一行开头的位置,把行号放过去;节点还没放进页面、或者折叠着时不量
  layoutLines() {
    const pos = this.getPos();
    if (pos == null || !this.dom.isConnected || this.dom.classList.contains("folded")) return;
    const text = this.node.textContent;
    const top = this.pre.getBoundingClientRect().top;
    const marks = [];
    let at = 0;
    for (let line = 1; ; line++) {
      let y;
      try {
        y = this.view.coordsAtPos(pos + 1 + at, 1).top - top;
      } catch (_) {
        return;
      }
      marks.push(`<span style="top:${y}px">${line}</span>`);
      const nl = text.indexOf("\n", at);
      if (nl === -1) break;
      at = nl + 1;
    }
    this.gutter.innerHTML = marks.join("");
  }

  // 顶栏里的输入框:标题和语言。回车或点到别处时写进文档,Esc 放弃修改
  field(cls, placeholder, attr, label) {
    const input = document.createElement("input");
    input.className = cls;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.setAttribute("aria-label", label);
    input.addEventListener("keydown", (e) => {
      // 输入法正在拼字时的回车、Esc 是给输入法的
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        this.commit(attr, input);
        this.focusCode();
      } else if (e.key === "Escape") {
        // 不让 Esc 传到窗口上把窗口藏起来
        e.preventDefault();
        e.stopPropagation();
        input.value = this.node.attrs[attr];
        this.focusCode();
      }
    });
    input.addEventListener("blur", () => this.commit(attr, input));
    input.addEventListener("input", () => this.fit(input));
    return input;
  }

  commit(attr, input) {
    let value = cleanInfo(input.value);
    // 语言只有一个词
    if (attr === "language") value = value.split(" ")[0] || "";
    if (value === this.node.attrs[attr]) {
      input.value = value;
      return;
    }
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, [attr]: value }));
  }

  // 光标放回代码的开头
  focusCode() {
    const pos = this.getPos();
    if (pos == null) return;
    const { state } = this.view;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)));
    this.view.focus();
  }

  // 输入框跟着内容变宽,空的时候和占位文字一样宽
  fit(input) {
    const text = input.value || input.placeholder;
    input.style.width = `calc(${[...text].reduce((w, c) => w + (c.charCodeAt(0) > 0xff ? 2 : 1), 0)}ch + 10px)`;
  }

  setFolded(folded) {
    this.dom.classList.toggle("folded", folded);
    this.toggle.setAttribute("aria-expanded", String(!folded));
    if (!folded) this.layoutLines();
  }

  async copyCode() {
    const ok = await copyText(this.node.textContent);
    this.copy.innerHTML = ok ? ICON_DONE : ICON_COPY;
    this.copy.title = ok ? "已复制" : "复制失败";
    this.copy.classList.toggle("done", ok);
    setTimeout(() => {
      this.copy.innerHTML = ICON_COPY;
      this.copy.title = this.node.attrs.language === "copy" ? "复制这行文字" : "复制代码";
      this.copy.classList.remove("done");
    }, 1400);
  }

  // 把节点的属性放到顶栏上
  sync() {
    const { title, language } = this.node.attrs;
    if (document.activeElement !== this.title) this.title.value = title;
    if (document.activeElement !== this.lang) this.lang.value = language;
    this.fit(this.title);
    this.fit(this.lang);
    this.dom.classList.toggle("no-title", !title);
    this.dom.classList.toggle("copyline", language === "copy");
    this.copy.title = language === "copy" ? "复制这行文字" : "复制代码";
    const lines = lineCount(this.node);
    this.count.textContent = `${lines} 行`;
    this.dom.style.setProperty("--digits", String(String(lines).length));
    // 内容放进页面以后再量行号的位置
    requestAnimationFrame(() => this.layoutLines());
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync();
    return true;
  }

  // 顶栏和行号里的点击和键盘留给它们自己,编辑器不管
  stopEvent(e) {
    return this.head.contains(e.target) || this.gutter.contains(e.target);
  }

  // 顶栏、行号和卡片自己的 class / style(折叠、行号宽度)变了不算文档变了
  ignoreMutation(m) {
    if (m.type === "selection") return false;
    if (m.target === this.dom && m.type === "attributes") return true;
    return this.head.contains(m.target) || this.gutter.contains(m.target);
  }

  destroy() {
    this.resize.disconnect();
  }
}

export const codeBlockView = $prose(
  () =>
    new Plugin({
      props: { nodeViews: { code_block: (node, view, getPos) => new CodeBlockView(node, view, getPos) } },
    }),
);

// ---------- 高亮 ----------
// 用 highlight.js 给代码上色:把它生成的 HTML 换成一段段的 class,再变成编辑器的装饰。
// 没改过的代码块(同一个节点对象)用上次算好的结果
const cache = new WeakMap();

const ENTITY = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };

// highlight.js 里 shell 是"命令行会话"(只给 $ 提示符上色),平时写 shell 的代码块其实是 bash 脚本
const ALIAS = { shell: "bash", sh: "bash", zsh: "bash", cmd: "dos", bat: "dos", ps: "powershell", ps1: "powershell", vue: "xml", html: "xml", toml: "ini", jsonc: "json" };

// 代码块用哪种语言上色:写的语言认识就用它;没写或者不认识就猜一个;text 这类纯文本不上色
export function highlightLanguage(lang) {
  lang = (lang || "").toLowerCase();
  const name = ALIAS[lang] || lang;
  if (name && hljs.getLanguage(name)) return name;
  return null;
}

function highlightRanges(node) {
  if (cache.has(node)) return cache.get(node);
  const text = node.textContent;
  const lang = node.attrs.language === "copy" ? null : highlightLanguage(node.attrs.language);
  let html = null;
  try {
    if (lang) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    // 没写语言(或者语言不认识)时猜一个来上色,猜的不一定对,所以不显示猜出来的语言名
    else if (node.attrs.language !== "copy" && text.length < 20000) html = hljs.highlightAuto(text).value;
  } catch (_) {}
  const ranges = [];
  if (html) {
    const stack = [];
    let pos = 0;
    const re = /<span class="([^"]*)">|<\/span>|(&[#\w]+;)|([^<&]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1] != null) stack.push(m[1]);
      else if (m[0] === "</span>") stack.pop();
      else {
        const len = m[2] ? (ENTITY[m[2]] ?? m[2]).length : m[3].length;
        if (stack.length) ranges.push([pos, pos + len, stack.join(" ")]);
        pos += len;
      }
    }
  }
  if (lang === "bash") shellCommands(text, ranges);
  cache.set(node, ranges);
  return ranges;
}

// highlight.js 的 bash 只认 echo、cd 这些内置命令,adb、git、npm 这样的命令名和 -x、--force 参数都不上色。
// 这里补上:每条命令开头的词(行首,或者 | && || ; 后面)当函数名,- 开头的参数当属性
function shellCommands(text, ranges) {
  const taken = (from, to) => ranges.some(([a, b]) => a < to && from < b);
  const add = [];
  const cmd = /(^|[|;&(]\s*|\n)([ \t]*)((?:sudo\s+)?)([^\s|;&()=<>'"#$`]+)(?=[\s;|&)]|$)/g;
  let m;
  while ((m = cmd.exec(text))) {
    const from = m.index + m[1].length + m[2].length + m[3].length;
    const to = from + m[4].length;
    if (!taken(from, to)) add.push([from, to, "hljs-title function_"]);
  }
  const opt = /(?<=[\s=])--?[A-Za-z][\w-]*/g;
  while ((m = opt.exec(text))) {
    const from = m.index;
    const to = from + m[0].length;
    if (!taken(from, to)) add.push([from, to, "hljs-attr"]);
  }
  ranges.push(...add);
  ranges.sort((a, b) => a[0] - b[0]);
}

function decorate(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return true;
    const start = pos + 1;
    for (const [from, to, cls] of highlightRanges(node)) decos.push(Decoration.inline(start + from, start + to, { class: cls }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const highlightKey = new PluginKey("minipad-code-highlight");
export const codeHighlight = $prose(
  () =>
    new Plugin({
      key: highlightKey,
      state: {
        init: (_, state) => decorate(state.doc),
        apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
      },
      props: { decorations: (state) => highlightKey.getState(state) },
    }),
);

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_) {}
    ta.remove();
    return ok;
  }
}
