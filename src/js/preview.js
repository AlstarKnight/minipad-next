// ---------- Markdown 阅读模式 ----------
import { preview } from "./dom.js";

export function setupMarkdown() {
  marked.setOptions({ gfm: true, breaks: true });
  // 代码块开头 ``` 后面第一个词是语言,其余的是标题:```js 牛奶测试
  marked.use({
    renderer: {
      code({ text, lang, escaped }) {
        const { language, title } = parseInfo(lang);
        const cls = language ? ` class="language-${esc(language)}"` : "";
        const data = title ? ` data-title="${esc(title)}"` : "";
        return `<pre><code${cls}${data}>${escaped ? text : esc(text)}</code></pre>\n`;
      },
    },
  });
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// 第一个词是认识的语言或者像个语言名(字母、数字和 # + . -)才算语言,不然整行都是标题
function parseInfo(info) {
  const m = /^(\S*)\s*(.*)$/.exec((info || "").trim());
  if (!m[1]) return { language: "", title: "" };
  if (hljs.getLanguage(m[1]) || /^[\w#+.-]+$/.test(m[1])) return { language: m[1], title: m[2] };
  return { language: "", title: m.input };
}

// 把高亮后的 HTML 按行拆开:跨行的 <span> 在行尾关掉,下一行开头再打开
function splitLines(html) {
  const lines = [];
  const open = [];
  let cur = "";
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else if (m[3]) {
      lines.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else cur += m[4];
  }
  lines.push(cur + "</span>".repeat(open.length));
  return lines;
}

const ICON_COPY = '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5"/></svg>';
const ICON_FOLD = '<svg viewBox="0 0 16 16"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';

export function renderPreview(md) {
  const html = DOMPurify.sanitize(marked.parse(md || ""), { ADD_ATTR: ["target"] });
  preview.innerHTML = html || '<p style="color:var(--muted)">(空白页面,按 Ctrl+E 开始编辑)</p>';
  preview.querySelectorAll("pre > code").forEach(codeBlock);
}

// 代码块做成卡片:顶栏是折叠按钮、标题、语言名和复制按钮,下面的代码带行号、长行自动换行
function codeBlock(code) {
  const pre = code.parentElement;
  const raw = code.textContent.replace(/\n$/, "");
  const langClass = [...code.classList].find((c) => c.startsWith("language-"));
  let lang = langClass ? langClass.slice(9) : "";
  let body = esc(raw);
  try {
    if (lang && hljs.getLanguage(lang)) {
      body = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
      lang = hljs.getLanguage(lang).name || lang;
    } else if (!lang && raw.length < 20000) {
      // 没写语言时猜一个来上色,猜的不一定对,所以不显示语言名
      body = hljs.highlightAuto(raw).value;
    }
  } catch (_) {}
  const lines = splitLines(body);
  code.className = "hljs";
  code.innerHTML = lines.map((l) => `<span class="cb-line">${l}</span>`).join("");
  code.style.setProperty("--digits", String(String(lines.length).length));

  const wrap = document.createElement("div");
  wrap.className = "codeblock";
  pre.replaceWith(wrap);

  const head = document.createElement("div");
  head.className = "cb-head";
  const toggle = document.createElement("button");
  toggle.className = "cb-toggle";
  toggle.title = "折叠 / 展开";
  toggle.setAttribute("aria-expanded", "true");
  toggle.innerHTML = ICON_FOLD;
  const title = document.createElement("span");
  title.className = "cb-title";
  title.textContent = code.dataset.title || "";
  toggle.appendChild(title);
  const count = document.createElement("span");
  count.className = "cb-count";
  count.textContent = `${lines.length} 行`;
  toggle.appendChild(count);
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const folded = wrap.classList.toggle("folded");
    toggle.setAttribute("aria-expanded", String(!folded));
  });
  head.appendChild(toggle);
  if (lang) {
    const tag = document.createElement("span");
    tag.className = "lang";
    tag.textContent = lang;
    head.appendChild(tag);
  }
  const btn = document.createElement("button");
  btn.className = "copy";
  btn.title = "复制代码";
  btn.innerHTML = ICON_COPY;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await copyText(raw);
    btn.innerHTML = ok ? ICON_DONE : ICON_COPY;
    btn.title = ok ? "已复制" : "复制失败";
    btn.classList.toggle("done", ok);
    setTimeout(() => {
      btn.innerHTML = ICON_COPY;
      btn.title = "复制代码";
      btn.classList.remove("done");
    }, 1400);
  });
  head.appendChild(btn);
  wrap.append(head, pre);
}

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
