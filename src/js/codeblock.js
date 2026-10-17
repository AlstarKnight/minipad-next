// ---------- 编辑区里的代码块 ----------
// 代码块是一张卡片:顶栏左边是折叠按钮和标题,右边是语言和复制按钮,标题和语言点一下就能改;
// 下面是代码,带语法高亮和行号(行号可以在设置里关掉),长行自动换行。
// 文件里还是普通的 Markdown:```js 牛奶测试,``` 后面第一个词是语言,其余的是标题。
import { codeBlockSchema, $prose, Plugin, PluginKey, Decoration, DecorationSet, TextSelection } from "../vendor/milkdown.js";

import { promptLanguage } from "./prompt-lang.js";
import { cleanMarkColor, colorStyle } from "./colors.js";
import { makeSharedColorTools } from "./sharedcolors.js";

hljs.registerLanguage("prompt", promptLanguage);

const FOLDED = "[minipad-folded]";
// 代码块里也能像正文一样给文字上颜色;代码本身保持纯文字(复制出去不带颜色),
// 颜色写在 ``` 那一行的末尾:[minipad-colors c0-5=#df2a3f;b8-12=#fbe9a6],c 是字体颜色,b 是背景颜色,数字是第几个字到第几个字
const COLORS = /(?:^|\s)\[minipad-colors ([^\]]*)\]$/;
const MARKS = { c: ["text_color", "color"], b: ["text_bg", "bg"] };
// 标题的颜色(0.4.3):整条标题一个颜色,写成 [minipad-title-color #df2a3f]
const TITLE_COLOR = /(?:^|\s)\[minipad-title-color ([^\]]*)\]$/;

function readColors(spec, length) {
  const out = [];
  for (const part of spec.split(";")) {
    const m = /^([cb])(\d+)-(\d+)=(.+)$/.exec(part.trim());
    if (!m) continue;
    const [from, to] = [Number(m[2]), Math.min(Number(m[3]), length)];
    const value = cleanMarkColor(m[4]);
    if (value && from < to) out.push({ kind: m[1], from, to, value });
  }
  return out;
}

function writeColors(node) {
  const out = [];
  node.forEach((child, offset) => {
    for (const mark of child.marks) {
      const kind = Object.keys(MARKS).find((k) => MARKS[k][0] === mark.type.name);
      if (!kind) continue;
      const value = mark.attrs[MARKS[kind][1]];
      const last = out.findLast((x) => x.kind === kind);
      // 挨着的同一种颜色合成一段
      if (last && last.to === offset && last.value === value) last.to = offset + child.nodeSize;
      else out.push({ kind, from: offset, to: offset + child.nodeSize, value });
    }
  });
  return out.length ? `[minipad-colors ${out.map((x) => `${x.kind}${x.from}-${x.to}=${x.value}`).join(";")}]` : "";
}

// 按颜色标记把代码切成几段放进文档
function addColoredText(state, schema, text, colors) {
  const cuts = [...new Set([0, text.length, ...colors.flatMap((c) => [c.from, c.to])])].sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const [from, to] = [cuts[i], cuts[i + 1]];
    const marks = colors.filter((c) => c.from <= from && c.to >= to);
    for (const c of marks) state.openMark(schema.marks[MARKS[c.kind][0]], { [MARKS[c.kind][1]]: c.value });
    state.addText(text.slice(from, to));
    for (const c of marks.reverse()) state.closeMark(schema.marks[MARKS[c.kind][0]]);
  }
}

// ---- 代码高亮配色:每个代码块在顶栏自己选(颜色在 style.css 里,每套分浅色和深色) ----
// 选了默认以外的配色时,``` 那一行末尾记一个 [minipad-theme dracula]
const CODE_THEMES = [
  ["", "默认"], ["github", "GitHub"], ["dracula", "Dracula"], ["nord", "Nord"], ["solarized", "Solarized"],
  ["monokai", "Monokai"], ["dreamy", "梦幻"], ["starry", "星空"], ["rainbow", "彩虹"],
];
const THEME = /(?:^|\s)\[minipad-theme ([a-z]+)\]$/;
const themeName = (t) => CODE_THEMES.find(([v]) => v === t)?.[1] || "默认";

// 配色的下拉列表,整个页面共用一个
const themeMenu = {
  el: null,
  owner: null,
  open(owner) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "menu cb-theme-menu";
      this.el.setAttribute("role", "listbox");
      this.el.setAttribute("aria-label", "代码配色");
      document.body.append(this.el);
      document.addEventListener("mousedown", (e) => {
        if (this.owner && !this.el.contains(e.target) && !this.owner.themeBtn.contains(e.target)) this.close();
      }, true);
      document.addEventListener("keydown", (e) => this.owner && e.key === "Escape" && (e.stopPropagation(), this.close()), true);
      document.addEventListener("scroll", () => this.owner && this.place(), true);
    }
    this.close();
    this.owner = owner;
    owner.themeBtn.setAttribute("aria-expanded", "true");
    const current = owner.node.attrs.theme || "";
    this.el.replaceChildren(...CODE_THEMES.map(([v, name]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.dataset.theme = v;
      b.classList.toggle("on", v === current);
      b.setAttribute("aria-selected", String(v === current));
      const dots = document.createElement("span");
      dots.className = "cb-theme-dots";
      if (v) dots.dataset.codeTheme = v;
      dots.innerHTML = "<i></i><i></i><i></i><i></i>";
      const label = document.createElement("span");
      label.textContent = name;
      b.append(dots, label);
      b.addEventListener("click", () => {
        this.close();
        owner.setTheme(v);
      });
      return b;
    }));
    this.el.hidden = false;
    this.place();
  },
  place() {
    const r = this.owner.themeBtn.getBoundingClientRect();
    const h = this.el.offsetHeight;
    const below = window.innerHeight - r.bottom - 6;
    this.el.style.top = `${below >= h || below >= r.top ? r.bottom + 2 : Math.max(4, r.top - h - 2)}px`;
    this.el.style.left = `${Math.max(4, Math.min(r.right - this.el.offsetWidth, window.innerWidth - this.el.offsetWidth - 4))}px`;
  },
  close() {
    if (this.el) this.el.hidden = true;
    this.owner?.themeBtn.setAttribute("aria-expanded", "false");
    this.owner = null;
  },
};

// ---- 标题旁的色块:选标题的颜色(纯色、渐变、材质),和正文的字体颜色用同一个颜色库 ----
let titleColorButton = true;
export function setTitleColorButton(enabled) {
  titleColorButton = enabled;
  document.querySelectorAll(".codeblock").forEach((el) => el.classList.toggle("no-title-color-btn", !enabled));
  if (!enabled) titleColorMenu.close();
}

const titleColorMenu = {
  el: null,
  owner: null,
  open(owner) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "menu fb-pop cb-title-color-menu";
      document.body.append(this.el);
      document.addEventListener("mousedown", (e) => {
        if (this.owner && !this.el.contains(e.target) && !this.owner.titleColorBtn.contains(e.target)) this.close();
      }, true);
      document.addEventListener("keydown", (e) => this.owner && e.key === "Escape" && (e.stopPropagation(), this.close()), true);
      document.addEventListener("scroll", () => this.owner && this.place(), true);
    }
    this.close();
    this.owner = owner;
    owner.titleColorBtn.setAttribute("aria-expanded", "true");
    const pick = (value) => {
      this.close();
      owner.setTitleColor(value);
    };
    const clear = document.createElement("button");
    clear.className = "fb-none";
    clear.textContent = "默认颜色";
    clear.addEventListener("click", () => pick(""));
    const shared = makeSharedColorTools({
      id: "text_color",
      getValue: () => owner.node.attrs.title_color || "#d9822b",
      onApply: pick,
      previewMode: "text",
    });
    this.el.replaceChildren(clear, shared.root);
    this.el.hidden = false;
    this.place();
  },
  place() {
    const r = this.owner.titleColorBtn.getBoundingClientRect();
    const h = this.el.offsetHeight;
    const below = window.innerHeight - r.bottom - 6;
    this.el.style.top = `${below >= h || below >= r.top ? r.bottom + 2 : Math.max(4, r.top - h - 2)}px`;
    this.el.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - this.el.offsetWidth - 4))}px`;
  },
  close() {
    if (this.el) this.el.hidden = true;
    this.owner?.titleColorBtn.setAttribute("aria-expanded", "false");
    this.owner = null;
  },
};

// ---- 点语言时的常用语言列表(列表里没有的也可以直接输入) ----
const LANGS = [
  ["prompt", "Prompt 提示词"], ["text", "纯文本"], ["bash", "Bash / Shell"], ["powershell", "PowerShell"],
  ["dos", "CMD 批处理"], ["python", "Python"], ["javascript", "JavaScript"], ["typescript", "TypeScript"],
  ["json", "JSON"], ["html", "HTML"], ["css", "CSS"], ["sql", "SQL"], ["markdown", "Markdown"],
  ["yaml", "YAML"], ["toml", "TOML"], ["xml", "XML"], ["java", "Java"], ["c", "C"], ["cpp", "C++"],
  ["csharp", "C#"], ["go", "Go"], ["rust", "Rust"], ["php", "PHP"], ["kotlin", "Kotlin"],
  ["swift", "Swift"], ["lua", "Lua"], ["diff", "Diff"], ["ini", "INI"],
];
let langMenu = true;
export function setLangMenu(enabled) {
  langMenu = enabled;
  if (!enabled) menu.close();
}

// 整个页面共用一个列表,跟着正在改的那个语言框
const menu = {
  el: null,
  input: null,
  items: [],
  active: -1,
  open(input, pick) {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "menu cb-lang-menu";
      this.el.setAttribute("role", "listbox");
      this.el.hidden = true;
      // 点列表不让语言框失去焦点
      this.el.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.append(this.el);
    }
    this.input = input;
    this.pick = pick;
    this.filter();
  },
  filter() {
    const q = this.input.value.trim().toLowerCase();
    const all = LANGS;
    const hit = (s) => s.toLowerCase().includes(q);
    const starts = (s) => s.toLowerCase().startsWith(q);
    this.items = !q || LANGS.some(([v]) => v === q)
      ? all
      : [...all.filter(([v, l]) => starts(v) || starts(l)), ...all.filter(([v, l]) => !(starts(v) || starts(l)) && (hit(v) || hit(l)))];
    // 打的已经是认识的语言(比如 py)时 Enter 就用打的;不认识时 Enter 用列表里第一个
    this.active = this.items.findIndex(([v]) => v === q);
    if (this.active < 0 && q && !hljs.getLanguage(q)) this.active = 0;
    if (!this.items.length) return this.close();
    this.el.replaceChildren(...this.items.map(([v, l], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.setAttribute("role", "option");
      b.dataset.lang = v;
      b.className = i === this.active ? "active" : "";
      b.innerHTML = `<span></span><small></small>`;
      b.firstChild.textContent = l;
      b.lastChild.textContent = v;
      b.addEventListener("click", () => this.pick(v));
      return b;
    }));
    this.el.hidden = false;
    this.place();
    this.el.children[this.active]?.scrollIntoView({ block: "nearest" });
  },
  place() {
    const r = this.input.getBoundingClientRect();
    const h = this.el.offsetHeight;
    const below = window.innerHeight - r.bottom - 6;
    this.el.style.top = `${below >= h || below >= r.top ? r.bottom + 2 : Math.max(4, r.top - h - 2)}px`;
    this.el.style.left = `${Math.max(4, Math.min(r.right - this.el.offsetWidth, window.innerWidth - this.el.offsetWidth - 4))}px`;
  },
  move(d) {
    if (!this.items.length) return;
    this.active = (this.active + d + this.items.length) % this.items.length;
    [...this.el.children].forEach((b, i) => b.classList.toggle("active", i === this.active));
    this.el.children[this.active].scrollIntoView({ block: "nearest" });
  },
  close() {
    if (this.el) this.el.hidden = true;
    this.input = null;
  },
  isOpenFor(input) {
    return this.input === input && this.el && !this.el.hidden;
  },
};

// 页面滚动时列表跟着语言框走
document.addEventListener("scroll", () => menu.input && menu.place(), true);

let persistFolds = true;
export function setCodeFoldPersistence(enabled) { persistFolds = enabled; }

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
    attrs: {
      ...base.attrs,
      title: { default: "", validate: "string" },
      folded: { default: false, validate: "boolean" },
      theme: { default: "", validate: "string" },
      title_color: { default: "", validate: "string" },
    },
    // 代码块里只能用字体颜色和背景颜色
    marks: "text_color text_bg",
    parseMarkdown: {
      match: base.parseMarkdown.match,
      runner: (state, node, type) => {
        // ``` 那一行末尾的标记:配色、标题颜色、颜色,最后是收起
        let info = [node.lang, node.meta].filter(Boolean).join(" ");
        const folded = info === FOLDED || info.endsWith(" " + FOLDED);
        if (folded) info = info.slice(0, -FOLDED.length).trimEnd();
        const colors = COLORS.exec(info);
        if (colors) info = info.slice(0, colors.index).trimEnd();
        const titleColor = TITLE_COLOR.exec(info);
        if (titleColor) info = info.slice(0, titleColor.index).trimEnd();
        const themed = THEME.exec(info);
        if (themed) info = info.slice(0, themed.index).trimEnd();
        const theme = CODE_THEMES.some(([v]) => v && v === themed?.[1]) ? themed[1] : "";
        const [lang, ...rest] = info.split(" ");
        const { language, title } = splitInfo(lang, rest.join(" "));
        const title_color = (title && cleanMarkColor(titleColor?.[1])) || "";
        state.openNode(type, { language, title, folded, theme, title_color });
        const text = node.value || "";
        if (colors) addColoredText(state, type.schema, text, readColors(colors[1], text.length));
        else if (text) state.addText(text);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: base.toMarkdown.match,
      runner: (state, node) => {
        const { lang, meta } = joinInfo(node.attrs.language, node.attrs.title);
        const theme = node.attrs.theme && `[minipad-theme ${node.attrs.theme}]`;
        // 没有标题时颜色也不用写
        const titleColor = meta && node.attrs.title_color && `[minipad-title-color ${node.attrs.title_color}]`;
        const info = [lang, meta, theme, titleColor, writeColors(node), node.attrs.folded && FOLDED].filter(Boolean).join(" ");
        const at = info.indexOf(" ");
        state.addNode("code", undefined, node.textContent, at < 0 ? { lang: info || null, meta: null } : { lang: info.slice(0, at), meta: info.slice(at + 1) });
      },
    },
  };
});

// ---------- 卡片 ----------
const ICON_COPY = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
const ICON_THEME = '<svg viewBox="0 0 16 16"><path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.3-.6 1.3-1.2 0-.8-.7-1.1-.7-1.9 0-.8.6-1.3 1.4-1.3h1.6a2.9 2.9 0 0 0 2.9-2.9C14.5 4.2 11.6 1.8 8 1.8Z"/><circle cx="4.9" cy="7.4" r=".9"/><circle cx="6.9" cy="4.8" r=".9"/><circle cx="10.1" cy="4.9" r=".9"/></svg>';
const ICON_FOLD = '<svg viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';

const lineCount = (node) => node.textContent.split("\n").length;

class CodeBlockView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.foldOverride = null;

    this.dom = document.createElement("div");
    this.dom.className = titleColorButton ? "codeblock" : "codeblock no-title-color-btn";
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
    this.titleColorBtn = document.createElement("button");
    this.titleColorBtn.className = "cb-title-color";
    this.titleColorBtn.setAttribute("aria-haspopup", "dialog");
    this.titleColorBtn.setAttribute("aria-label", "标题颜色");
    this.titleColorBtn.title = "标题颜色";
    this.titleColorBtn.addEventListener("click", () => (titleColorMenu.owner === this ? titleColorMenu.close() : titleColorMenu.open(this)));
    this.count = document.createElement("span");
    this.count.className = "cb-count";
    this.lang = this.field("cb-lang", "语言", "language", "代码的语言,比如 js、python");
    this.langList();

    this.copy = document.createElement("button");
    this.copy.className = "copy";
    this.copy.title = "复制代码";
    this.copy.innerHTML = ICON_COPY;
    this.copy.addEventListener("click", () => this.copyCode());

    this.themeBtn = document.createElement("button");
    this.themeBtn.className = "cb-theme";
    this.themeBtn.innerHTML = ICON_THEME;
    this.themeBtn.setAttribute("aria-haspopup", "listbox");
    this.themeBtn.addEventListener("click", () => (themeMenu.owner === this ? themeMenu.close() : themeMenu.open(this)));

    head.append(this.toggle, this.title, this.titleColorBtn, this.count, this.lang, this.themeBtn, this.copy);
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

  // 语言框:获得焦点、打字时列出常用语言,↑↓ 选、Enter 或点一下用它
  langList() {
    const input = this.lang;
    const pick = (v) => {
      input.value = v;
      this.fit(input);
      menu.close();
      this.commit("language", input);
      this.focusCode();
    };
    const show = () => langMenu && this.view.editable && menu.open(input, pick);
    input.addEventListener("focus", show);
    input.addEventListener("input", () => (menu.isOpenFor(input) ? menu.filter() : show()));
    input.addEventListener("blur", () => menu.isOpenFor(input) && menu.close());
    // 先于 field() 里的 Enter / Esc 处理
    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229 || !menu.isOpenFor(input)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        menu.move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter" && menu.active >= 0) {
        input.value = menu.items[menu.active][0];
        menu.close();
      } else if (e.key === "Escape" || e.key === "Tab") {
        menu.close();
      }
    }, true);
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

  setTheme(theme) {
    const pos = this.getPos();
    if (pos == null || !this.view.editable || theme === this.node.attrs.theme) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, theme }));
  }

  setTitleColor(value) {
    const pos = this.getPos();
    const title_color = cleanMarkColor(value);
    if (pos == null || !this.view.editable || title_color === this.node.attrs.title_color) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, title_color }));
  }

  setFolded(folded) {
    const pos = this.getPos();
    if (persistFolds && this.view.editable && pos != null) {
      this.foldOverride = null;
      if (folded !== this.node.attrs.folded) {
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, folded })
          .setMeta("addToHistory", false));
      }
    } else {
      // 只读页面或关闭持久化时，只改变这次查看的状态。
      this.foldOverride = folded;
    }
    this.paintFolded(folded);
  }

  paintFolded(folded) {
    this.dom.classList.toggle("folded", folded);
    this.toggle.setAttribute("aria-expanded", String(!folded));
    if (!folded) this.layoutLines();
  }

  async copyCode() {
    if (!this.node.textContent) return;
    const ok = await copyText(this.node.textContent);
    this.copy.innerHTML = ok ? ICON_DONE : ICON_COPY;
    this.copy.title = ok ? "已复制" : "复制失败";
    this.copy.classList.toggle("done", ok);
    setTimeout(() => {
      this.copy.innerHTML = ICON_COPY;
      this.copy.title = this.node.attrs.language === "copy" ? "复制文本" : "复制代码";
      this.copy.classList.remove("done");
    }, 1400);
  }

  // 把节点的属性放到顶栏上
  sync() {
    const { title, language, theme, title_color } = this.node.attrs;
    if (theme) this.dom.dataset.codeTheme = theme;
    else delete this.dom.dataset.codeTheme;
    this.themeBtn.title = `代码配色:${themeName(theme)}`;
    this.themeBtn.disabled = !this.view.editable;
    this.titleColorBtn.disabled = !this.view.editable;
    // 标题和色块按钮都用这个颜色
    this.title.style.cssText = title_color ? colorStyle(title_color) : "";
    if (title_color) this.titleColorBtn.style.setProperty("--tc", title_color);
    else this.titleColorBtn.style.removeProperty("--tc");
    if (document.activeElement !== this.title) this.title.value = title;
    if (document.activeElement !== this.lang) this.lang.value = language;
    this.fit(this.title);
    this.fit(this.lang);
    this.dom.classList.toggle("no-title", !title);
    this.dom.classList.toggle("copyline", language === "copy");
    this.copy.title = language === "copy" ? "复制文本" : "复制代码";
    this.copy.disabled = language === "copy" && !this.node.textContent;
    const lines = lineCount(this.node);
    this.count.textContent = `${lines} 行`;
    this.dom.style.setProperty("--digits", String(String(lines).length));
    this.paintFolded(this.foldOverride ?? this.node.attrs.folded);
    // 内容放进页面以后再量行号的位置
    requestAnimationFrame(() => this.layoutLines());
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.folded !== this.node.attrs.folded) this.foldOverride = null;
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
    if (menu.input === this.lang) menu.close();
    if (themeMenu.owner === this) themeMenu.close();
    if (titleColorMenu.owner === this) titleColorMenu.close();
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
