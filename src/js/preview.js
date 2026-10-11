// ---------- Markdown 阅读模式 ----------
import { preview } from "./dom.js";

export function setupMarkdown() {
  marked.setOptions({ gfm: true, breaks: true });
}

export function renderPreview(md) {
  const html = DOMPurify.sanitize(marked.parse(md || ""), { ADD_ATTR: ["target"] });
  preview.innerHTML = html || '<p style="color:var(--muted)">(空白页面,按 Ctrl+E 开始编辑)</p>';
  preview.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    const wrap = document.createElement("div");
    wrap.className = "codeblock";
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const raw = code.textContent;
    const langClass = [...code.classList].find((c) => c.startsWith("language-"));
    const lang = langClass ? langClass.slice(9) : "";
    try {
      if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
      else if (raw.length < 20000) {
        const r = hljs.highlightAuto(raw);
        code.innerHTML = r.value;
        code.classList.add("hljs");
      }
    } catch (_) {}
    if (lang) {
      const tag = document.createElement("span");
      tag.className = "lang";
      tag.textContent = lang;
      wrap.appendChild(tag);
    }
    const btn = document.createElement("button");
    btn.className = "copy";
    btn.textContent = "复制";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyText(raw.replace(/\n$/, ""));
      btn.textContent = ok ? "已复制" : "复制失败";
      btn.classList.toggle("done", ok);
      setTimeout(() => {
        btn.textContent = "复制";
        btn.classList.remove("done");
      }, 1400);
    });
    wrap.appendChild(btn);
  });
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
