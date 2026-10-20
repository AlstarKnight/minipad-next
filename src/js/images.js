// ---------- 图片:粘贴、拖进来的图片存进笔记本文件夹里的 assets(0.4.0) ----------
// 页面里写成 ![](assets/img-….png),别的 Markdown 软件打开也看得到;
// 编辑器里显示时换成后端的地址(Rust 里的 note_image),从这个笔记本的文件夹读。
import { $prose, Plugin, TextSelection } from "../vendor/milkdown.js";
import { api, isMock } from "./api.js";
import { state, book } from "./state.js";
import { toast } from "./ui.js";

const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
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

// 存好图片,在 pos(没给就是光标处)插进去
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
  if (!saved.length || !view.editable) return;
  const { schema } = view.state;
  let tr = view.state.tr;
  if (pos != null) tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
  for (const s of saved) tr = tr.replaceSelectionWith(schema.nodes.image.create(s), false);
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
          const files = imageFiles(e.dataTransfer?.files);
          if (state.settings?.image_paste === false || !view.editable || !files.length) return false;
          e.preventDefault();
          const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
          void insertImages(view, files, at ? at.pos : null);
          return true;
        },
      },
    }),
);
