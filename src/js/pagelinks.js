// ---------- 页面链接的写法:[[页面名]] 和 [[笔记本/页面名]](0.5.0) ----------
// 文件里存的就是这几个字。这里只管认出链接、算出指向哪一页、改名和移动以后怎么改写,不碰界面。
// 页面名和笔记本名里不会有 /(系统不允许,后端会换成 _),所以第一个 / 就是笔记本和页面的分隔;
// 名字里不能有方括号和换行。不分大小写,前后的空格不算

export const DEFAULT_BOOK_LABEL = "默认";
const LINK = /\[\[([^\[\]\n]+)\]\]/g;

// 链接里写的笔记本名:默认笔记本写成「默认」
export const labelOf = (bookName) => bookName || DEFAULT_BOOK_LABEL;

// "笔记本/页面" → { book: "笔记本", page: "页面" };没写笔记本时 book 是 null
export function parseTarget(target) {
  const i = target.indexOf("/");
  if (i < 0) return { book: null, page: target.trim() };
  return { book: target.slice(0, i).trim(), page: target.slice(i + 1).trim() };
}

// 一段文字里的链接:[{ from, to, target }],from / to 含两边的方括号
export function findPageLinks(text) {
  const out = [];
  if (!text.includes("[[")) return out;
  for (const m of text.matchAll(LINK)) {
    // [[...]] 这样起不出页面名的不算
    if (fileName(parseTarget(m[1]).page)) out.push({ from: m.index, to: m.index + m[0].length, target: m[1] });
  }
  return out;
}

// 名字里有方括号的页面写不成链接
export const linkable = (name) => !/[\[\]]/.test(name);

// 和后端给页面起名的规矩一样(notes.rs 的 clean_name):系统不允许的字符换成 _,最多 80 个字,
// 去掉末尾的点和空格,点开头的换成 _,设备名(CON、COM1 这些)后面加 _。
// 点 [[a?b]] 新建出来的页面叫 a_b,这个链接以后照样指向它
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i;
const fit = (s) => [...s].slice(0, 80).join("").trimEnd().replace(/[. ]+$/, "");
export function fileName(name) {
  let s = fit(name.replace(/[<>:"/\\|?*\p{Cc}]/gu, "_").trimStart());
  if (s.startsWith(".")) s = "_" + s.slice(1);
  const stem = s.split(".")[0].replace(/ +$/, "");
  return RESERVED.test(stem) ? fit(stem + "_" + s.slice(stem.length)) : s;
}

// 名单索引:笔记本名(小写) → { name, pages: Map(页面名小写 → 页面名) }。books: [{ name, pages: [页面名] }]
export function makeIndex(books) {
  const index = new Map();
  for (const b of books) index.set(b.name.toLowerCase(), { name: b.name, pages: new Map(b.pages.map((p) => [p.toLowerCase(), p])) });
  return index;
}

function bookIn(index, label) {
  const key = label.toLowerCase();
  return index.get(key === DEFAULT_BOOK_LABEL ? "" : key);
}

// 链接指向哪:{ book, page, exists }。book 是笔记本的实际名字,找不到笔记本时是 null(bookLabel 是链接里写的);
// page 是页面的实际名字,页面不存在时是链接里写的
export function resolveTarget(index, target, home) {
  const t = parseTarget(target);
  const b = t.book == null ? index.get(home.toLowerCase()) : bookIn(index, t.book);
  if (!b) return { book: null, bookLabel: t.book ?? home, page: t.page, exists: false };
  const page = b.pages.get(t.page.toLowerCase()) ?? b.pages.get(fileName(t.page).toLowerCase());
  return { book: b.name, page: page ?? t.page, exists: page != null };
}

// 新名字写进 [[ ]] 时按 Markdown 的规矩转义(和保存时的写法一样),读回来还是这个名字。
// 页面名和笔记本名里本来就没有 \ * < > 这些(系统不允许),剩下要管的只有这几个
const word = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
function escapeName(s) {
  return s.replace(/[`&~_]/g, (c, i) => (c === "_" && word(s[i - 1]) && word(s[i + 1]) ? c : "\\" + c));
}
const unescape = (s) => s.replace(/\\([!-\/:-@\[-`{-~])/g, "$1");

// 文件里的代码块、行内代码(里面的不是链接)和链接。链接可能是以前的版本保存时转义过的 \[\[名字]],
// 名字里也可能有转义(\_ \& 这些)
const CODE_OR_LINK = /^(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\1[^\n]*$|[\s\S]*)|(?<!\\)`[^`\n]+`|\\?\[\\?\[((?:\\[^\[\]\n]|[^\\\[\]\n])+)\]\]/gm;

// 改名、移动以后,一页 Markdown 里的链接要怎么改写。返回改写后的内容,不用改时原样返回。
// md 所在的页面是 home = { book, page };index 是改之前的名单;change(都是改之前的名字)是下面一种:
//   { page: [笔记本, 旧名, 新名] }              页面改名
//   { book: [旧名, 新名] }                     笔记本改名
//   { move: [笔记本, 页面, 新笔记本, 新名] }     页面移到别的笔记本(那边重名时会换个名字)
// 原来写的是 [[页面]] 的仍写短的,写了笔记本的仍写笔记本;短的写法在新位置对不上时补上笔记本名。
// 指向不存在的页面的链接不动
export function retarget(md, home, index, change) {
  if (!md.includes("[[") && !md.includes("\\[\\[")) return md;
  // 这一页改完以后在哪个笔记本
  const moved = change.move && change.move[0] === home.book && change.move[1] === home.page;
  const newHome = change.book?.[0] === home.book ? change.book[1] : moved ? change.move[2] : home.book;
  return md.replace(CODE_OR_LINK, (all, fence, inner) => {
    if (inner == null) return all;
    const target = unescape(inner);
    const t = parseTarget(target);
    const r = resolveTarget(index, target, home.book);
    if (!t.page || !r.exists) return all;
    // 指向的页面改完以后在哪
    let book = r.book;
    let page = r.page;
    if (change.page && change.page[0] === r.book && change.page[1] === r.page) page = change.page[2];
    if (change.book && change.book[0] === r.book) book = change.book[1];
    if (change.move && change.move[0] === r.book && change.move[1] === r.page) [book, page] = [change.move[2], change.move[3]];
    // 页面名字没变,或者只改了大小写(链接照样对得上)
    const samePage = page === r.page || page.toLowerCase() === t.page.toLowerCase();
    if (t.book == null) {
      if (book === newHome && samePage) return all;
      return `[[${book === newHome ? "" : escapeName(labelOf(book)) + "/"}${escapeName(page)}]]`;
    }
    if (book === r.book && samePage) return all;
    return `[[${escapeName(labelOf(book))}/${escapeName(page)}]]`;
  });
}
