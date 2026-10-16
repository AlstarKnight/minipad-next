// ---------- 从 minipad2 导入 ----------
// 选好 minipad2 的文件夹后先看看里面有什么(minipad2_preview),选好选项后先放进暂存区(minipad2_stage):
// 列出会建的笔记本和页面,可以取消勾选不要的;确认以后才写进笔记文件夹(minipad2_import)。
// 已有的笔记不会被改动;导入完换到第一个新笔记本。从设置里打开时盖在设置上面,关掉以后回到设置
import { api } from "./api.js";
import { $ } from "./dom.js";
import { state } from "./state.js";
import { flushAll, saveMeta } from "./save.js";
import { mutate, applyDisk } from "./sync.js";
import { switchBook, closeBooks } from "./notebooks.js";
import { focusEditor } from "./ui.js";

// 找到的数据:{ path, preview },还没选好或者没找到时是 null
let found = null;
// 这次打开以来选过的文件夹,再打开导入窗口时直接用
let lastPath = "";
// 正在导入:这时不能关窗口
let busy = false;
// 导入完了,窗口里显示的是结果
let done = false;
// 暂存区:{ books: [{ name, pages: [{ name, chars, preview }] }], skipped, warnings },还在选选项时是 null
let staged = null;
// 换了文件夹时,之前还没回来的结果不要
let looking = 0;

const CHECKS = ["highlights", "lists", "clips", "recycle", "skip-empty"];

export function openImport() {
  closeBooks();
  found = null;
  done = false;
  staged = null;
  $("#import-stage").hidden = true;
  $("#import-back").hidden = true;
  $("#import-setup").hidden = false;
  $("#import-found").hidden = true;
  $("#import-result").hidden = true;
  $("#import-cancel").hidden = false;
  $("#import-ok").textContent = "预览";
  showWarnings([]);
  showError("");
  updateButtons();
  $("#import").hidden = false;
  $("#import-path").value = lastPath;
  if (lastPath) void look(lastPath);
  else void pick();
}

// 关掉导入窗口,返回原来开着没有(导入中不关,也算处理了 Esc)
export function closeImport() {
  if ($("#import").hidden) return false;
  if (busy) return true;
  $("#import").hidden = true;
  if (!$("#settings").hidden) $("#set-import").focus();
  else focusEditor();
  return true;
}

async function pick() {
  try {
    const dir = await api.invoke("pick_folder", { title: "选择 minipad2 的程序文件夹(或者它的 data 文件夹)" });
    if (!dir || $("#import").hidden) return;
    $("#import-path").value = dir;
    await look(dir);
  } catch (e) {
    showError(String(e));
  }
}

// 看看文件夹里有没有 minipad2 的数据、有多少页面
async function look(path) {
  path = path.trim();
  const ticket = ++looking;
  found = null;
  showError("");
  updateButtons();
  if (!path) {
    $("#import-found").hidden = true;
    showWarnings([]);
    return;
  }
  try {
    const preview = await api.invoke("minipad2_preview", { path });
    if (ticket !== looking) return;
    found = { path: preview.folder || path, preview };
    lastPath = path;
    showFound(preview);
  } catch (e) {
    if (ticket !== looking) return;
    $("#import-found").hidden = true;
    showWarnings([]);
    showError(String(e));
  }
}

// 数量是 0 的选项不显示
function option(name, count, checked, text) {
  $(`#import-${name}-row`).hidden = !count;
  $(`#import-${name === "empty" ? "skip-empty" : name}`).checked = checked;
  if (text) $(`#import-${name}-text`).textContent = text;
}

function showFound(p) {
  const parts = [];
  if (p.groups) parts.push(`${p.groups} 个分组`);
  parts.push(`${p.pages} 个笔记页面`);
  $("#import-summary").textContent = `找到了 minipad2 ${p.version} 的数据:${parts.join("、")}。`;
  $("#import-layout-row").hidden = !p.groups;
  $("#import-layout").value = "groups";
  $("#import-base").value = "minipad2";
  option("highlights", p.highlights, true);
  option("lists", p.lists, true, `${p.lists} 个备忘录、链接、通讯录这类列表页面,每个整理成一页`);
  option("clips", p.clips, false, `剪贴文字(${p.clips} 条),放进一页`);
  option("recycle", p.recycled, false);
  option("empty", p.empty, true, `跳过 ${p.empty} 个空白的页面`);
  showWarnings(p.warnings);
  $("#import-found").hidden = false;
  updateButtons();
}

function options() {
  return {
    layout: $("#import-layout").value,
    base: $("#import-base").value.trim() || "minipad2",
    skip_empty: $("#import-skip-empty").checked,
    lists: $("#import-lists").checked,
    clips: $("#import-clips").checked,
    recycle: $("#import-recycle").checked,
    highlights: $("#import-highlights").checked,
  };
}

// 按现在的选项有没有东西可以导入
function anything() {
  const p = found?.preview;
  if (!p) return false;
  const o = options();
  return p.pages - (o.skip_empty ? p.empty : 0) > 0 || (o.lists && p.lists > 0) || (o.clips && p.clips > 0) || (o.recycle && p.recycled > 0);
}

// 跟着选项变的文字和按钮
function updateButtons() {
  const p = found?.preview;
  if (p) {
    const single = $("#import-layout").value === "single" || !p.groups;
    $("#import-base-label").textContent = single ? "导入到笔记本" : "分组外的页面放进";
    $("#import-recycle-text").textContent = `回收站里的 ${p.recycled} 页,放进「${options().base} 回收站」笔记本`;
  }
  const ok = $("#import-ok");
  if (staged && !done) {
    const n = pickedPages();
    ok.disabled = busy || !n;
    ok.textContent = busy ? "导入中…" : n ? `导入 ${n} 页` : "导入";
    ok.title = n ? "" : "一页都没勾选";
    $("#import-stage-summary").textContent = stageSummary();
    return;
  }
  ok.disabled = busy || (!done && !anything());
  ok.title = !done && p && !anything() ? "按现在的选项没有可以导入的页面" : "";
}

function setBusy(on) {
  busy = on;
  for (const el of $("#import").querySelectorAll("input, select, button")) el.disabled = on;
  $("#import-ok").textContent = on ? (staged ? "导入中…" : "整理中…") : done ? "完成" : staged ? "导入" : "预览";
  if (!on) updateButtons();
}

// ---- 暂存区:按选项整理好的笔记本和页面,勾掉不要的再导入 ----
async function runStage() {
  if (!found || busy) return;
  setBusy(true);
  showError("");
  try {
    staged = await api.invoke("minipad2_stage", { path: found.path, options: options() });
    showStage();
  } catch (e) {
    staged = null;
    showError(String(e));
  } finally {
    setBusy(false);
  }
}

const pageBoxes = () => [...$("#import-stage-list").querySelectorAll("input.st-page")];
const pickedPages = () => pageBoxes().filter((c) => c.checked).length;

function stageSummary() {
  const boxes = pageBoxes();
  const books = new Set(boxes.filter((c) => c.checked).map((c) => c.dataset.book)).size;
  const all = boxes.length;
  const n = pickedPages();
  const skipped = staged.skipped ? `,跳过 ${staged.skipped} 个空白页面` : "";
  return `暂存区:会新建 ${books} 个笔记本、${n} 页(共 ${all} 页${skipped})。还没有写进笔记文件夹,勾掉不要的再导入;笔记本和已有的重名时会自动加编号。`;
}

function showStage() {
  $("#import-setup").hidden = true;
  const list = $("#import-stage-list");
  list.replaceChildren(
    ...staged.books.map((b, i) => {
      const box = document.createElement("details");
      box.className = "st-book";
      box.open = staged.books.length <= 3;
      const head = document.createElement("summary");
      const all = document.createElement("input");
      all.type = "checkbox";
      all.className = "st-book-check";
      all.checked = true;
      all.setAttribute("aria-label", `导入笔记本「${b.name}」`);
      all.addEventListener("click", (e) => e.stopPropagation());
      all.addEventListener("change", () => {
        for (const c of box.querySelectorAll("input.st-page")) c.checked = all.checked;
        all.indeterminate = false;
        updateButtons();
      });
      const name = document.createElement("span");
      name.className = "st-name";
      name.textContent = b.name;
      const count = document.createElement("span");
      count.className = "muted";
      count.textContent = `${b.pages.length} 页`;
      head.append(all, name, count);
      const pages = document.createElement("div");
      pages.className = "st-pages";
      b.pages.forEach((pg, j) => {
        const row = document.createElement("label");
        row.className = "st-page-row";
        const c = document.createElement("input");
        c.type = "checkbox";
        c.className = "st-page";
        c.checked = true;
        c.dataset.book = String(i);
        c.dataset.page = String(j);
        c.addEventListener("change", () => {
          const boxes = [...pages.querySelectorAll("input.st-page")];
          const on = boxes.filter((x) => x.checked).length;
          all.checked = on > 0;
          all.indeterminate = on > 0 && on < boxes.length;
          updateButtons();
        });
        const text = document.createElement("span");
        const n = document.createElement("span");
        n.className = "st-name";
        n.textContent = pg.name;
        const meta = document.createElement("span");
        meta.className = "muted st-preview";
        meta.textContent = `${pg.chars} 字${pg.preview ? " · " + pg.preview : ""}`;
        text.append(n, meta);
        row.append(c, text);
        pages.appendChild(row);
      });
      box.append(head, pages);
      return box;
    }),
  );
  $("#import-stage").hidden = false;
  $("#import-back").hidden = false;
  showWarnings(staged.warnings);
  updateButtons();
  $("#import-ok").focus();
}

// 回到选项
function backToSetup() {
  if (busy) return;
  staged = null;
  $("#import-stage").hidden = true;
  $("#import-back").hidden = true;
  $("#import-setup").hidden = false;
  $("#import-ok").textContent = "预览";
  showWarnings(found?.preview?.warnings || []);
  showError("");
  updateButtons();
}

// 没勾上的笔记本和页面
function leave() {
  const books = [];
  const pages = [];
  staged.books.forEach((b, i) => {
    const boxes = pageBoxes().filter((c) => c.dataset.book === String(i));
    if (!boxes.some((c) => c.checked)) books.push(i);
    else for (const c of boxes) if (!c.checked) pages.push([i, Number(c.dataset.page)]);
  });
  return { books, pages };
}

async function runImport() {
  if (!found || !staged || busy) return;
  const skip = leave();
  setBusy(true);
  showError("");
  try {
    // 先把还没保存的修改写进去,导入完从磁盘读回新的笔记本(已有的页面照常合并)
    await flushAll();
    await saveMeta();
    // 导入时不和磁盘同步,免得读到导入了一半的笔记本、把页面顺序打乱
    const r = await mutate(async () => {
      try {
        return await api.invoke("minipad2_import", { path: found.path, options: options(), leave: skip });
      } finally {
        // 中途出错时已经导入的笔记本也要显示出来
        await applyDisk(await api.invoke("read_notes"));
      }
    });
    done = true;
    showResult(r);
    const first = state.books.find((b) => b.name === r.books[0]);
    if (first) await switchBook(first);
  } catch (e) {
    showError(String(e));
  } finally {
    setBusy(false);
  }
  if (done) $("#import-ok").focus();
}

function showResult(r) {
  $("#import-setup").hidden = true;
  $("#import-stage").hidden = true;
  $("#import-back").hidden = true;
  const box = $("#import-result");
  const line = (text) => {
    const p = document.createElement("p");
    p.textContent = text;
    return p;
  };
  const lines = [];
  if (!r.books.length) lines.push(line("没有导入任何页面。"));
  else {
    const names = r.books.slice(0, 6).map((b) => `「${b}」`).join("、");
    const more = r.books.length > 6 ? ` 等 ${r.books.length} 个` : "";
    lines.push(line(`导入了 ${r.pages} 页,新建了 ${r.books.length} 个笔记本:${names}${more}。`));
    lines.push(line("点顶栏左边的笔记本名字可以在笔记本之间切换。"));
  }
  if (r.skipped) lines.push(line(`跳过了 ${r.skipped} 个空白的页面。`));
  box.replaceChildren(...lines);
  box.hidden = false;
  showWarnings(r.warnings);
  $("#import-cancel").hidden = true;
}

// 数据里有看不懂、对不上的地方:照样导入,在这里列出来
function showWarnings(list) {
  const ul = $("#import-warnings");
  const items = list.slice(0, 50).map((w) => {
    const li = document.createElement("li");
    li.textContent = w;
    return li;
  });
  if (list.length > 50) {
    const li = document.createElement("li");
    li.textContent = `还有 ${list.length - 50} 条`;
    items.push(li);
  }
  ul.replaceChildren(...items);
  ul.hidden = !items.length;
}

function showError(msg) {
  const el = $("#import-error");
  el.textContent = msg;
  el.hidden = !msg;
}

export function bindImport() {
  $("#books-import").addEventListener("click", openImport);
  $("#import-pick").addEventListener("click", pick);
  // 也可以直接粘贴路径,回车或者离开输入框时看看里面有什么
  $("#import-path").addEventListener("change", () => look($("#import-path").value));
  $("#import-layout").addEventListener("change", updateButtons);
  $("#import-base").addEventListener("input", updateButtons);
  for (const name of CHECKS) $(`#import-${name}`).addEventListener("change", updateButtons);
  $("#import-cancel").addEventListener("click", closeImport);
  $("#import-back").addEventListener("click", backToSetup);
  $("#import-ok").addEventListener("click", () => (done ? closeImport() : staged ? runImport() : runStage()));
}
