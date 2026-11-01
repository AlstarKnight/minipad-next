// ---------- 分享到 Minipad(0.5.5,安卓) ----------
// 别的 App 里点「分享」选 Minipad:分享的文字(和带的标题、链接)记到设好的页面,默认是默认笔记本的「收集箱」。
// 写法和电脑上的快速记录一样:前面加时间,每一条是段落、列表项或待办,加在末尾或开头(页面以标题开头时放在标题下面),
// 挨着列表时接在那个列表里。这里只管把分享的内容写成 Markdown、放进页面的文字,读写文件在 mobile.js
import { formatDate } from "./datetime.js";

export const DEFAULT_SHARE_PAGE = "收集箱";
// 「每次新建一页」时新页面的名字
export const SHARE_PAGE_NAME = "分享 {{日期}} {{时间:HH.mm}}";

// 拆开分享的内容:末尾是网址时拆出来。标题是分享时带的标题;没带标题而网址前面只有一行字时,那一行就是标题
export function parseShared({ text = "", title = "" } = {}) {
  let body = String(text).replace(/\r\n?/g, "\n").trim();
  let name = String(title).trim();
  let url = "";
  const m = body.match(/https?:\/\/\S+$/);
  if (m) {
    url = m[0];
    body = body.slice(0, m.index).replace(/[\s:：]+$/, "");
    if (!name && body && !body.includes("\n")) {
      name = body;
      body = "";
    }
  }
  if (body === name) body = "";
  return { body, title: name, url };
}

// 分享来的是纯文字:会被当成 Markdown 格式的字符前面加 \,显示出来还是原来的字。
// 字母、数字中间的 _ 不会变成斜体,不用加
const inline = (s) =>
  s.replace(/[\\`*[\]<~]/g, "\\$&").replace(/_/g, (m, i, t) => (/[\p{L}\p{N}]/u.test(t[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(t[i + 1] ?? "") ? m : "\\_"));
// 行首会变成标题、引用、列表、分隔线、表格的
const BLOCK_START = /^(?:#{1,6}(?:\s|$)|>|[-+](?:\s|$)|-{2,}|=+\s*$|\|)/;

function plain(line) {
  // 网址原样留着(网址里加了 \ 就认不出来了)
  let out = "";
  let last = 0;
  for (const m of line.matchAll(/https?:\/\/\S+/g)) {
    out += inline(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  out += inline(line.slice(last));
  if (BLOCK_START.test(out)) out = "\\" + out;
  return out.replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
}

// 一行一行,空行不要(一条分享是一个段落或一个列表项)
const textLines = (text) => String(text).replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).map(plain);

// 一条分享写成的几行 Markdown;什么也没有时是空数组。
// source 关着时原样记下分享的文字,不拆标题和链接,也不加分享时带的标题
export function shareLines(shared, { stamp = true, source = true, date = new Date() } = {}) {
  let out;
  if (source) {
    const p = parseShared(shared);
    const name = inline(p.title);
    const link = p.url ? (name ? `[${name}](${p.url.replace(/[()<>]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())})` : p.url) : name;
    out = [...textLines(p.body), ...(link ? [link] : [])];
  } else out = textLines(shared?.text ?? "");
  if (out.length && stamp) out[0] = formatDate(date) + " " + out[0];
  return out;
}

// format:paragraph 段落、list 列表项、task 待办;marker 是接着的那个列表用的符号
export function shareBlock(lines, format = "paragraph", marker = "-") {
  if (format !== "list" && format !== "task") return lines.join("\n");
  const head = marker + " " + (format === "task" ? "[ ] " : "");
  return lines.map((l, i) => (i ? "  " : head) + l).join("\n");
}

const BULLET = /^([-*+])[ \t]/;

// 把这一条放进页面的文字里:where 是 end(末尾)或 start(开头,页面以 # 标题开头时放在标题下面)
export function insertShare(md, lines, { where = "end", format = "paragraph" } = {}) {
  const list = format === "list" || format === "task";
  const text = String(md).replace(/\s+$/, "");
  if (where === "start") {
    const m = text.match(/^(?:[ \t]*\n)*(#{1,6}(?:[ \t][^\n]*)?)(?:\n|$)/);
    const rest = (m ? text.slice(m[0].length) : text).replace(/^(?:[ \t]*\n)*/, "");
    const near = list ? rest.match(BULLET) : null;
    const block = shareBlock(lines, format, near?.[1]);
    return (m ? m[1] + "\n\n" : "") + block + (rest ? (near ? "\n" : "\n\n") + rest : "") + "\n";
  }
  const blocks = text.split(/\n[ \t]*\n/);
  const near = list ? blocks[blocks.length - 1].match(BULLET) : null;
  const block = shareBlock(lines, format, near?.[1]);
  return (text ? text + (near ? "\n" : "\n\n") : "") + block + "\n";
}
