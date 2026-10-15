// ---------- 顶层 Markdown 块的菜单与拖放 ----------
// 直接操作 ProseMirror 节点；笔记仍用原有 Markdown 读写，不另存块结构。
import { $prose, Plugin, TextSelection, closeHistory } from "../vendor/milkdown.js";
import { openMenu } from "./ui.js";

const TYPES = [
  ["paragraph", "正文"], ["heading1", "标题 1"], ["heading2", "标题 2"],
  ["heading3", "标题 3"], ["heading4", "标题 4"], ["blockquote", "引用"],
  ["bullet_list", "无序列表"], ["ordered_list", "编号列表"],
  ["code_block", "代码块"], ["hr", "分隔线"],
];

function blockAt(doc, index) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function makeBlock(schema, kind, source = null) {
  const text = source ? source.textBetween(0, source.content.size, "\n") : "";
  // 段落与标题互转时保留加粗、链接等行内格式。
  const content = source && ["paragraph", "heading"].includes(source.type.name)
    ? source.content : text ? [schema.text(text)] : null;
  const paragraph = () => schema.nodes.paragraph.create(null, content);
  if (kind.startsWith("heading")) return schema.nodes.heading.create({ level: Number(kind.slice(-1)) }, content);
  if (kind === "paragraph") return paragraph();
  if (kind === "code_block") return schema.nodes.code_block.create(null, text ? schema.text(text) : null);
  if (kind === "blockquote") return schema.nodes.blockquote.create(null, paragraph());
  if (kind === "bullet_list" || kind === "ordered_list") {
    return schema.nodes[kind].create(null, schema.nodes.list_item.create(null, paragraph()));
  }
  if (kind === "hr") return schema.nodes.hr.create();
  return null;
}

class BlockHandles {
  constructor(view) {
    this.view = view;
    this.host = document.getElementById("main");
    this.scroller = document.getElementById("editor");
    this.index = -1;
    this.dragging = -1;
    this.pointerDown = false;
    this.dropIndex = -1;
    this.handle = document.createElement("button");
    this.handle.type = "button";
    this.handle.className = "block-handle";
    this.handle.textContent = "⠿";
    this.handle.title = "拖动块；点击或右键管理块";
    this.handle.setAttribute("aria-label", "管理当前块");
    this.handle.draggable = true;
    this.handle.hidden = true;
    this.marker = document.createElement("div");
    this.marker.className = "block-drop-line";
    this.marker.hidden = true;
    this.host.append(this.handle, this.marker);

    this.onMove = (e) => {
      if (this.dragging !== -1 || this.pointerDown) return;
      const index = this.indexOf(e.target);
      this.show(index);
    };
    this.onLeave = (e) => {
      if (this.dragging === -1 && !this.pointerDown && e.relatedTarget !== this.handle) this.show(-1);
    };
    // 按住手柄到 dragstart 之间保留 DOM，否则浏览器会取消拖动。
    this.onPress = (e) => { if (e.button === 0) this.pointerDown = true; };
    this.onRelease = () => { this.pointerDown = false; };
    this.onContext = (e) => {
      if (e.shiftKey || e.target.closest?.("input, textarea")) return;
      const index = this.indexOf(e.target);
      if (index < 0 || !this.view.editable) return;
      e.preventDefault();
      this.show(index);
      this.menu(index, e.clientX, e.clientY);
    };
    this.onScroll = () => this.position();
    this.onStart = (e) => {
      if (this.index < 0 || !this.view.editable) return;
      this.pointerDown = false;
      this.dragging = this.index;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "minipad-block");
    };
    this.onOver = (e) => {
      if (this.dragging < 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = "move";
      const index = this.indexOf(e.target);
      if (index < 0) {
        this.dropIndex = this.view.state.doc.childCount;
      } else {
        const rect = this.view.dom.children[index].getBoundingClientRect();
        this.dropIndex = index + (e.clientY >= rect.top + rect.height / 2 ? 1 : 0);
      }
      this.marker.hidden = false;
      this.positionMarker();
    };
    this.onDrop = (e) => {
      if (this.dragging < 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const from = this.dragging;
      const to = this.dropIndex;
      this.finishDrag();
      this.move(from, to);
    };
    this.onEnd = () => this.finishDrag();
    this.handle.addEventListener("click", () => {
      if (this.index < 0) return;
      const rect = this.handle.getBoundingClientRect();
      this.menu(this.index, rect.right, rect.bottom);
    });
    this.handle.addEventListener("mousedown", this.onPress);
    document.addEventListener("mouseup", this.onRelease);
    this.handle.addEventListener("dragstart", this.onStart);
    this.handle.addEventListener("dragend", this.onEnd);
    this.view.dom.addEventListener("mousemove", this.onMove);
    this.view.dom.addEventListener("mouseleave", this.onLeave);
    this.view.dom.addEventListener("contextmenu", this.onContext);
    // 捕获自有手柄的 drop，阻止 ProseMirror 将拖放携带的文本粘贴进文档。
    this.view.dom.addEventListener("dragover", this.onOver, true);
    this.view.dom.addEventListener("drop", this.onDrop, true);
    this.scroller.addEventListener("scroll", this.onScroll);
    this.handle.addEventListener("mouseleave", this.onLeave);
  }

  indexOf(target) {
    let el = target instanceof Element ? target : target?.parentElement;
    while (el && el.parentElement !== this.view.dom) el = el.parentElement;
    if (!el || el.parentElement !== this.view.dom) return -1;
    const index = Array.prototype.indexOf.call(this.view.dom.children, el);
    return index < this.view.state.doc.childCount ? index : -1;
  }

  show(index) {
    this.index = index;
    this.position();
  }

  position() {
    if (this.index < 0 || !this.view.editable || this.index >= this.view.state.doc.childCount) {
      this.handle.hidden = true;
      return;
    }
    const el = this.view.dom.children[this.index];
    if (!el) { this.handle.hidden = true; return; }
    const rect = el.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    if (rect.bottom <= host.top || rect.top >= host.bottom) { this.handle.hidden = true; return; }
    this.handle.style.top = Math.max(0, rect.top - host.top + 2) + "px";
    this.handle.style.left = Math.max(2, rect.left - host.left - 27) + "px";
    this.handle.hidden = false;
  }

  positionMarker() {
    const index = this.dropIndex;
    if (index < 0) return;
    const el = this.view.dom.children[Math.min(index, this.view.state.doc.childCount - 1)];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const host = this.host.getBoundingClientRect();
    const y = index === this.view.state.doc.childCount ? rect.bottom : rect.top;
    this.marker.style.top = y - host.top + "px";
    this.marker.style.left = Math.max(4, rect.left - host.left) + "px";
    this.marker.style.width = Math.max(20, Math.min(rect.width, host.width - 45)) + "px";
  }

  finishDrag() {
    this.dragging = -1;
    this.dropIndex = -1;
    this.marker.hidden = true;
  }

  // to 为原文档的块边界索引；移走来源后修正落点。
  move(from, to) {
    const { state } = this.view;
    if (!this.view.editable || from < 0 || to < 0 || from >= state.doc.childCount ||
      to > state.doc.childCount || to === from || to === from + 1) return;
    const node = state.doc.child(from);
    const start = blockAt(state.doc, from);
    const boundary = blockAt(state.doc, to);
    const tr = closeHistory(state.tr).delete(start, start + node.nodeSize);
    const at = boundary - (to > from ? node.nodeSize : 0);
    tr.insert(at, node);
    this.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1))).scrollIntoView());
    this.view.focus();
    this.show(-1);
  }

  change(index, action, kind) {
    const { state } = this.view;
    if (!this.view.editable || index < 0 || index >= state.doc.childCount) return;
    const node = state.doc.child(index);
    const start = blockAt(state.doc, index);
    const end = start + node.nodeSize;
    let tr = closeHistory(state.tr);
    let at = start;
    if (action === "insert-before" || action === "insert-after") {
      const added = makeBlock(state.schema, kind);
      if (!added) return;
      at = action === "insert-before" ? start : end;
      tr = tr.insert(at, added);
    } else if (action === "convert") {
      const replacement = makeBlock(state.schema, kind, node);
      if (!replacement) return;
      tr = tr.replaceWith(start, end, replacement);
    } else if (action === "duplicate") {
      at = end;
      tr = tr.insert(at, node);
    } else if (action === "delete") {
      if (state.doc.childCount === 1) tr = tr.replaceWith(start, end, state.schema.nodes.paragraph.create());
      else tr = tr.delete(start, end);
      at = Math.min(start, tr.doc.content.size);
    }
    if (!tr.docChanged) return;
    this.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(at + 1, tr.doc.content.size)))).scrollIntoView());
    this.view.focus();
    this.show(-1);
  }

  menu(index, x, y) {
    x = Math.max(4, Math.min(x, window.innerWidth - 190));
    y = Math.max(4, Math.min(y, window.innerHeight - 340));
    const node = this.view.state.doc.child(index);
    if (!node || !this.view.editable) return;
    const types = (action) => openMenu(TYPES.map(([kind, name]) => ({
      id: "block-type-" + kind, label: name,
      act: () => this.change(index, action, kind),
    })), x, y);
    openMenu([
      { id: "block-insert-before", label: "在上方插入块 ›", act: () => types("insert-before") },
      { id: "block-insert-after", label: "在下方插入块 ›", act: () => types("insert-after") },
      { id: "block-convert", label: "转换块类型 ›", disabled: node.type.name === "table", act: () => types("convert") },
      { id: "block-up", label: "上移一块", disabled: index === 0, act: () => this.move(index, index - 1) },
      { id: "block-down", label: "下移一块", disabled: index === this.view.state.doc.childCount - 1, act: () => this.move(index, index + 2) },
      { id: "block-duplicate", label: "复制块", act: () => this.change(index, "duplicate") },
      { id: "block-delete", label: "删除块", danger: true, act: () => this.change(index, "delete") },
    ], x, y);
  }

  update(view) {
    this.view = view;
    this.position();
  }

  destroy() {
    this.finishDrag();
    this.handle.removeEventListener("mousedown", this.onPress);
    document.removeEventListener("mouseup", this.onRelease);
    this.view.dom.removeEventListener("mousemove", this.onMove);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
    this.view.dom.removeEventListener("contextmenu", this.onContext);
    this.view.dom.removeEventListener("dragover", this.onOver, true);
    this.view.dom.removeEventListener("drop", this.onDrop, true);
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.handle.remove();
    this.marker.remove();
  }
}

export const blockManager = $prose(() => new Plugin({ view: (view) => new BlockHandles(view) }));
