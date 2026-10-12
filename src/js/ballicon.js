// ---------- 悬浮图标的样子 ----------
// 悬浮图标窗口(ball.html)和设置里的预览共用:应用图标或自定义图片,可以上色。
// 上色用 mix-blend-mode: color —— 只换颜色,明暗保留,白色的线条还是白的。
import { parseAccent, gradientOf } from "./accent.js";

export const APP_ICON = "icons/app.png";

// el 里面要有 <img> 和 .tint;info 是 { size, icon, color, image }
export function paintBall(el, info) {
  const src = info.icon === "custom" && info.image ? info.image : APP_ICON;
  el.style.setProperty("--ball-size", (info.size || 48) + "px");
  el.style.opacity = (info.opacity || 100) / 100;
  const img = el.querySelector("img");
  if (img.getAttribute("src") !== src) img.src = src;
  const tint = el.querySelector(".tint");
  const c = parseAccent(info.color);
  tint.hidden = !c;
  if (c) {
    tint.style.background = c.to ? gradientOf(c.stops, c.deg) : c.from;
    tint.style.setProperty("--mask", `url("${src}")`);
  }
}
