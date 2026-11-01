// ---------- 图片:粘贴、拖进来的图片存进笔记本文件夹里的 assets(0.4.0) ----------
// 页面里写成 ![](assets/img-….png),别的 Markdown 软件打开也看得到;
// 编辑器里显示时换成后端的地址(Rust 里的 note_image),从这个笔记本的文件夹读。
// 拖进来的别的文件(0.5.6)也复制进 assets,写成附件链接 [📎 报告.pdf（1.2 MB）](assets/报告.pdf)
import { $prose, Plugin, TextSelection } from "../vendor/milkdown.js";
import { api, isMock } from "./api.js";
import { state, book } from "./state.js";
import { toast } from "./ui.js";
import { attachmentLabel } from "./attachments.js";

const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg", "image/avif": "avif" };
// Windows 和 Android 上自定义协议的地址是 http(s)://note.localhost/…,和页面本身用同一个协议
// (Windows 主窗口是 https,小窗和手机是 http);别的系统是 note://localhost/…
const HOSTED = /Windows/.test(navigator.userAgent) || document.documentElement.dataset.mobile === "true";
const SIZES = ["full", "medium", "small"];

export function applyImageSettings(s) {
  document.documentElement.dataset.imageSize = SIZES.includes(s.image_size) ? s.image_size : "full";
}

// 页面里写的图片地址换成能显示的:网上的、data: 原样;相对路径(assets/…)从这个笔记本的文件夹读
export function imageSrc(src, bookName = book()?.name ?? "") {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return src || "";
  if (isMock) return window.__mockImage?.(bookName, src) || "";
  const q = `book=${encodeURIComponent(bookName)}&path=${encodeURIComponent(src)}`;
  return (HOSTED ? `${location.protocol}//note.localhost/img?` : "note://localhost/img?") + q;
}

const imageFiles = (list) => [...(list || [])].filter((f) => TYPES[f.type]);

// 存好图片,在 pos(没给就是光标处)插进去;插了就返回 true(光标在插进去的图片后面)
async function insertImages(view, files, pos) {
  const bookName = book()?.name ?? "";
  const saved = [];
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const meta = encodeURIComponent(JSON.stringify({ book: bookName, ext: TYPES[f.type] }));
      const src = await api.invoke("save_image", bytes, { headers: { "x-image": meta } });
      // 截图粘贴进来叫 image.png,不当成图片说明
      const alt = /^image\.\w+$/i.test(f.name || "") ? "" : (f.name || "").replace(/\.\w+$/, "");
      saved.push({ src, alt });
    } catch (e) {
      toast("图片没存上:" + e, 5000);
    }
  }
  if (!saved.length || !view.editable) return false;
  const { schema } = view.state;
  let tr = view.state.tr;
  if (pos != null) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
  for (const s of saved) tr = tr.replaceSelectionWith(schema.nodes.image.create(s), false);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

// ---------- 附件(0.5.6):拖进来的文件一块一块传给后端(每块 4 MB,大文件不用整个读进内存) ----------
const CHUNK = 4 * 1024 * 1024;
async function saveAttachment(file, bookName) {
  const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    for (let at = 0; ; at += CHUNK) {
      const last = at + CHUNK >= file.size;
      const bytes = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
      const meta = encodeURIComponent(JSON.stringify({ book: bookName, name: file.name, id, offset: at, last }));
      const rel = await api.invoke("save_attachment", bytes, { headers: { "x-attachment": meta } });
      if (last) return rel;
    }
  } catch (e) {
    // 读文件出错时后端还留着传了一半的那份
    void api.invoke("discard_attachment", { book: bookName, id }).catch(() => {});
    throw e;
  }
}

// 存好附件,在 pos(没给就是光标处)插进链接,几个文件之间换行
async function insertAttachments(view, files, pos) {
  if (!files.length) return;
  const s = state.settings || {};
  const limit = (Number(s.attachment_max_mb) || 50) * 1024 * 1024;
  const bookName = book()?.name ?? "";
  const big = files.filter((f) => f.size > limit);
  if (big.length) toast(`${big.map((f) => `「${f.name}」`).join("、")}超过 ${s.attachment_max_mb || 50} MB,没有存(设置 → 编辑 里可以改上限)`, 6000);
  const todo = files.filter((f) => f.size <= limit);
  if (!todo.length) return;
  // 大文件要传一会儿:先说一声,传完换成结果
  const slow = todo.reduce((n, f) => n + f.size, 0) > 8 * 1024 * 1024;
  if (slow) toast("正在保存附件……", 120000);
  const saved = [];
  const failed = [];
  for (const f of todo) {
    try {
      saved.push({ href: await saveAttachment(f, bookName), text: attachmentLabel(f.name, f.size, { size: s.attachment_label !== "name", clip: s.attachment_clip !== false }) });
    } catch (e) {
      failed.push(`「${f.name}」没存上:${e}`);
    }
  }
  if (failed.length) toast(failed.join(";"), 6000);
  else if (slow) toast(saved.length > 1 ? `已存好 ${saved.length} 个附件` : "已存好附件", 1500);
  if (!saved.length || !view.editable) return;
  const { schema } = view.state;
  const nodes = saved.flatMap((x, i) => [
    ...(i ? [schema.nodes.hardbreak.create({ isInline: true })] : []),
    schema.text(x.text, [schema.marks.link.create({ href: x.href })]),
  ]);
  let tr = view.state.tr;
  if (pos != null) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
  for (const n of nodes) tr = tr.replaceSelectionWith(n, false);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

class ImageView {
  constructor(node) {
    this.dom = document.createElement("img");
    this.dom.addEventListener("error", () => {
      this.dom.classList.add("broken");
      this.dom.title = "找不到图片:" + this.node.attrs.src;
    });
    this.dom.addEventListener("load", () => this.dom.classList.remove("broken"));
    this.update(node);
  }
  update(node) {
    if (node.type.name !== "image") return false;
    if (this.node?.attrs.src !== node.attrs.src) this.dom.src = imageSrc(node.attrs.src);
    this.node = node;
    this.dom.alt = node.attrs.alt || "";
    this.dom.title = node.attrs.title || node.attrs.alt || "";
    return true;
  }
  ignoreMutation() {
    return true;
  }
}

export const imagePlugin = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: { image: (node) => new ImageView(node) },
        handlePaste(view, e) {
          const files = imageFiles(e.clipboardData?.files);
          if (state.settings?.image_paste === false || !view.editable || !files.length) return false;
          e.preventDefault();
          void insertImages(view, files, null);
          return true;
        },
        handleDrop(view, e) {
          const all = [...(e.dataTransfer?.files || [])];
          const images = state.settings?.image_paste === false ? [] : imageFiles(all);
          const attach = state.settings?.attachment_drop !== false;
          // 文件夹也会出现在 files 里(没法当附件):拖放的时候就得认出来,事件过去以后就读不到了
          const folders = new Set(attach ? [...(e.dataTransfer?.items || [])].map((item, i) => item.webkitGetAsEntry?.()?.isDirectory && all[i]).filter(Boolean) : []);
          const others = attach ? all.filter((f) => !TYPES[f.type] && !folders.has(f)) : [];
          if (!view.editable || (!images.length && !others.length && !folders.size)) return false;
          e.preventDefault();
          if (folders.size) toast("文件夹不能存成附件,可以把里面的文件拖进来");
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
          const pos = at ? at.pos : null;
          // 附件跟在图片后面(插了图片时光标就在图片后面)
          void insertImages(view, images, pos).then((placed) => insertAttachments(view, others, placed ? null : pos));
          return true;
        },
      },
    }),
);
