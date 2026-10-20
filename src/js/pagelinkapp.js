// ---------- 电脑版的页面链接(0.5.0):页面名单、点链接打开或新建、改名和移动时更新链接 ----------
import { api, isMiniWindow } from "./api.js";
import { state, book, current, makeNote } from "./state.js";
import { toast, ask, focusEditor } from "./ui.js";
import { flushAll, scheduleMeta, scheduleSave } from "./save.js";
import { syncContent, setEditorText } from "./editor.js";
import { mutate } from "./sync.js";
import { recent } from "./page.js";
import { goTo } from "./tabs.js";
import { setPageLinkHost, pageNamesChanged, linkIndex, pageLinksOn } from "./pagelinkview.js";
import { resolveTarget, retarget, linkable } from "./pagelinks.js";

const home = () => (current() ? book().name : null);

// 补全的候选:最近打开的在前,然后是当前笔记本、别的笔记本(按笔记本列表的顺序);当前页面不列
function candidates(books) {
  const cur = home();
  const sorted = [...books.filter((b) => b.name === cur), ...books.filter((b) => b.name !== cur)];
  const self = current()?.name;
  const all = sorted.flatMap((b) => b.pages.filter((p) => !(b.name === cur && p === self)).map((p) => ({ book: b.name, name: p })));
  const order = new Map(recent.map((n, i) => [n, i]));
  const seen = new Map();
  for (const b of state.books) for (const n of b.notes) if (order.has(n)) seen.set(b.name + "\n" + n.name, order.get(n));
  const rank = (c) => seen.get(c.book + "\n" + c.name) ?? Infinity;
  return all.map((c, i) => ({ c, i })).sort((x, y) => rank(x.c) - rank(y.c) || x.i - y.i).map((x) => x.c);
}

const namesOf = () => state.books.map((b) => ({ name: b.name, pages: b.notes.map((n) => n.name) }));

export function bindPageLinks() {
  if (isMiniWindow) {
    // 小窗只读了自己这一页:页面名单问后端要(只列名字,不读内容),窗口获得焦点时再要一次;
    // 点链接交给主窗口打开
    let books = [];
    const load = () => api.invoke("page_index")
      .then((list) => {
        books = list.map((b) => ({ name: b.name, pages: b.notes }));
        pageNamesChanged();
      })
      .catch(() => {});
    setPageLinkHost({
      home,
      books: () => books,
      candidates: () => candidates(books),
      open: (target) => api.invoke("open_page_in_main", { book: home() ?? "", target }).catch((e) => toast(String(e))),
    });
    void load();
    api.listen("window-focus", load);
    return;
  }
  setPageLinkHost({
    home,
    books: namesOf,
    candidates: () => candidates(namesOf()),
    open: (target) => void openPageLink(target),
  });
  // 小窗里点的链接
  api.listen("open-page", (e) => void openPageLink(e.payload.target, e.payload.book));
}

// 打开链接指向的页面;页面不存在就在那个笔记本里新建(放在最后),再过去
async function openPageLink(target, from = home() ?? "") {
  const r = resolveTarget(linkIndex(), target, from);
  const b = state.books.find((x) => x.name === r.book);
  if (!b) return toast(`没有「${r.bookLabel}」这个笔记本`);
  let n = r.exists ? b.notes.find((x) => x.name === r.page) : null;
  if (!n) {
    try {
      await flushAll();
      n = await mutate(async () => {
        const note = makeNote(await api.invoke("create_note", { book: b.name, name: r.page }), "");
        b.notes.push(note);
        scheduleMeta(b);
        pageNamesChanged();
        return note;
      });
    } catch (e) {
      return toast("新建页面失败:" + e);
    }
  }
  goTo(b, n);
  focusEditor();
}

// ---------- 改名、移动时更新链接 ----------
// 后端改好以后、这边的名单更新之前调用(用的是改之前的名单),change 的写法见 pagelinks.js 的 retarget。
// 返回要改的页面,等名单更新完交给 updateLinks
export function planLinks(change) {
  const mode = state.settings?.page_link_rename;
  if (!pageLinksOn() || mode === "off") return null;
  syncContent();
  const index = linkIndex();
  const edits = [];
  const skipped = [];
  for (const b of state.books) {
    for (const n of b.notes) {
      if (n.unreadable) continue;
      const after = retarget(n.content, { book: b.name, page: n.name }, index, change);
      if (after === n.content) continue;
      // 小窗里的页面由小窗保存,这边改了会被盖掉
      if (n.mini) skipped.push(n);
      else edits.push({ n, before: n.content, after });
    }
  }
  return edits.length || skipped.length ? { edits, skipped, change } : null;
}

// 改 2 个以上页面时先列出来问一下(设置成「直接改」就不问);改完提示,可以撤销
export async function updateLinks(plan) {
  if (!plan) return;
  const { edits, skipped, change } = plan;
  const name = change.page?.[2] ?? change.book?.[1] ?? change.move?.[3];
  const where = change.move ? change.move[2] : null;
  if (!linkable(name) || (where != null && !linkable(where))) {
    return toast(`「${name}」里有方括号,写不成 [[…]],其他页面里指向它的链接没有更新`, 5000);
  }
  const list = (pages) => pages.slice(0, 8).map((n) => `「${n.name}」`).join("、") + (pages.length > 8 ? ` 等 ${pages.length} 个页面` : "");
  if (edits.length >= 2 && state.settings?.page_link_rename !== "auto") {
    const ok = await ask(`有 ${edits.length} 个页面里有指向它的链接:${list(edits.map((e) => e.n))}\n要同时更新这些链接吗?`, "更新链接");
    if (!ok) return;
  }
  syncContent();
  // 问的时候页面可能又变了(同步回来新内容):这样的页面不动
  const done = edits.filter((e) => e.n.content === e.before && !e.n.mini && !e.n.unreadable && state.books.some((b) => b.notes.includes(e.n)));
  for (const e of done) setContent(e.n, e.after);
  const away = skipped.length ? `;${list(skipped)}正在小窗里编辑,里面的链接没有更新` : "";
  if (!done.length) return away && toast(away.slice(1), 5000);
  toast(`已更新 ${done.length} 个页面里的链接${away}`, 8000, { label: "撤销", act: () => undoLinks(done) });
}

function setContent(n, md) {
  n.content = md;
  // 正在显示的页面直接换上(Ctrl+Z 能撤回);别的页面等换过去时再换
  if (n === current()) setEditorText(n);
  scheduleSave(n);
}

// 撤销:只改回这次改过、之后没再动过的页面
function undoLinks(done) {
  syncContent();
  let kept = 0;
  for (const e of done) {
    if (e.n.content !== e.after || e.n.mini || !state.books.some((b) => b.notes.includes(e.n))) kept++;
    else setContent(e.n, e.before);
  }
  toast(kept ? `已撤销;${kept} 个页面后来又改过,没有动` : "已撤销链接的修改");
}
