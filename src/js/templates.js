// ---------- 模板(0.5.1) ----------
// 「模板」笔记本(设置里可以换名字)里的每一页就是一个模板:页面名是新页面的名字,内容是新页面的内容,
// 都可以用 {{日期}} 这些变量(见 vars.js),{{光标}} 是建好后光标放的地方。
// 右键 + 按钮或者 Ctrl+Shift+N 选模板新建页面
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state, book, current, makeNote, makeBook, bookLabel, sortBooks } from "./state.js";
import { toast, openMenu } from "./ui.js";
import { scheduleSave, scheduleMeta } from "./save.js";
import { mutate } from "./sync.js";
import { rememberView } from "./page.js";
import { newNote } from "./tabs.js";
import { switchBook } from "./notebooks.js";
import { editorView } from "./editor.js";
import { fillVars, CURSOR } from "./vars.js";
import { TextSelection, Selection } from "../vendor/milkdown.js";

export const DEFAULT_TEMPLATE_BOOK = "模板";

// 第一次用时放进模板笔记本的两个例子
const SAMPLES = [
  ["日记 {{日期}}", "# {{日期}} {{星期}}\n\n{{光标}}\n"],
  ["会议记录", "# {{标题}}\n\n- 时间:{{日期}} {{时间}}\n- 参加:\n\n## 内容\n\n{{光标}}\n\n## 待办\n\n- [ ] 写下要做的事\n"],
];

export function templateBook() {
  const name = state.settings?.template_book || DEFAULT_TEMPLATE_BOOK;
  return state.books.find((b) => b.name === name) || null;
}

// x、y 是菜单出现的位置
export function openTemplateMenu(x, y) {
  const tb = templateBook();
  const items = [];
  if (!tb) items.push({ id: "create-templates", label: "新建模板笔记本", act: () => void createTemplateBook() });
  else if (!tb.notes.length) items.push({ id: "no-templates", label: `「${bookLabel(tb)}」里还没有页面`, disabled: true, act: () => {} });
  for (const t of tb?.notes || []) items.push({ id: "template", label: t.name, disabled: t.unreadable, act: () => void fromTemplate(t) });
  items.push({ id: "blank", label: "空白页面", act: () => void newNote() });
  if (tb) items.push({ id: "edit-templates", label: "编辑模板…", act: () => void switchBook(tb) });
  openMenu(items, x, y);
  $("#ctx").querySelector("button:not(:disabled)")?.focus();
}

// Ctrl+Shift+N:菜单出现在 + 按钮下面(按钮藏起来了就在窗口左上角)
export function openTemplateMenuAtButton() {
  const r = $("#btn-new").getBoundingClientRect();
  openTemplateMenu(r.width ? r.left : 12, r.width ? r.bottom + 4 : 48);
}

async function fromTemplate(t) {
  // 正在编辑的就是这个模板:先把编辑器里的内容收回来
  if (t === current()) rememberView();
  const s = state.settings || {};
  const vars = { dateFormat: s.date_format, book: bookLabel(book()) };
  await newNote(null, {
    name: fillVars(t.name, vars).trim() || "新页面",
    content: (name) => fillVars(t.content, { ...vars, title: name, cursor: true }),
    done: (n) => {
      placeCursor();
      scheduleSave(n);
    },
  });
}

// 光标放到 {{光标}} 的地方(去掉占位的字),没有就放在最后
function placeCursor() {
  const view = editorView();
  let at = null;
  view.state.doc.descendants((node, pos) => {
    if (at == null && node.isText && node.text.includes(CURSOR)) at = pos + node.text.indexOf(CURSOR);
    return at == null;
  });
  const tr = view.state.tr.setMeta("addToHistory", false);
  if (at != null) tr.delete(at, at + 1).setSelection(TextSelection.create(tr.doc, at));
  else tr.setSelection(Selection.atEnd(tr.doc));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

async function createTemplateBook() {
  const name = state.settings?.template_book || DEFAULT_TEMPLATE_BOOK;
  let tb;
  try {
    tb = await mutate(async () => {
      const b = makeBook(await api.invoke("create_book", { name }));
      for (const [page, content] of SAMPLES) {
        const n = makeNote(await api.invoke("create_note", { book: b.name, name: page }), "");
        n.content = content;
        b.notes.push(n);
      }
      state.books.push(b);
      sortBooks();
      for (const n of b.notes) scheduleSave(n);
      scheduleMeta(b);
      return b;
    });
  } catch (e) {
    toast("新建模板笔记本失败:" + e);
    return;
  }
  await switchBook(tb);
  toast(`建好了「${bookLabel(tb)}」笔记本:里面的每一页就是一个模板,可以照着例子改`, 5000);
}

export function bindTemplates() {
  $("#btn-new").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openTemplateMenu(e.clientX, e.clientY);
  });
  // 菜单里上下键换一项(Ctrl+Shift+N 打开时只用键盘)
  $("#ctx").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...$("#ctx").querySelectorAll("button:not(:disabled)")];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  });
}
