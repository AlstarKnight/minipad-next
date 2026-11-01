// ---------- 附件链接(0.5.6):[📎 季度报告.pdf（1.2 MB）](assets/季度报告.pdf) ----------
// 电脑上拖进编辑区的文件、手机上分享来的文件都写成这样。文件本身在笔记本的 assets 里(后端放进去、起名字),
// 这里只管链接上显示的文字和 Markdown 的写法。设置里可以不要 📎、不要大小
import { inline } from "./share.js";

// 1.2 MB、350 KB、800 B(按 1024 算,和资源管理器里看到的一样)
export function sizeText(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} GB`;
}

// 链接上显示的文字:📎 文件名（大小）
export function attachmentLabel(name, size, { clip = true, size: withSize = true } = {}) {
  return (clip ? "📎 " : "") + name + (withSize && size != null ? `（${sizeText(size)}）` : "");
}

// 写进页面的 Markdown。文字里的 [ ] * _ 这些转义;地址里有空格或括号时写在 <> 里(编辑器保存时也这么写)
export function attachmentMarkdown(rel, name, size, opts) {
  const dest = /[\s()<>]/.test(rel) ? `<${rel.replace(/[<>]/g, "\\$&")}>` : rel;
  return `[${inline(attachmentLabel(name, size, opts))}](${dest})`;
}

// 图片:![](assets/img-….jpg)
export const imageMarkdown = (rel) => `![](${/[\s()<>]/.test(rel) ? `<${rel}>` : rel})`;
