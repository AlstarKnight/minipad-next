// ---------- 悬浮图标窗口 ----------
// 按住拖动可以移到任何地方;不拖、直接点一下就放出笔记窗口。
import { api } from "./api.js";
import { paintBall } from "./ballicon.js";

const ball = document.getElementById("ball");

let openOn = "click";
async function render() {
  try {
    const info = await api.invoke("ball_info");
    openOn = info.open === "dblclick" ? "dblclick" : "click";
    ball.title = openOn === "dblclick" ? "双击打开悬浮笔记,按住可以拖动" : "点击打开悬浮笔记,按住可以拖动";
    paintBall(ball, info);
  } catch (e) {
    console.error(e);
  }
}

let down = null;
ball.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
});
ball.addEventListener("pointermove", (e) => {
  if (!down || Math.hypot(e.screenX - down.x, e.screenY - down.y) < 4) return;
  // 动了几个像素就算拖动:交给系统拖窗口,松手后不会再当成点击
  down = null;
  window.__TAURI__?.window.getCurrentWindow().startDragging();
});
// 单击打开;设成双击打开时,350 毫秒内点两下才打开
let lastClick = 0;
ball.addEventListener("pointerup", (e) => {
  if (!down) return;
  down = null;
  if (openOn === "dblclick" && e.timeStamp - lastClick > 350) {
    lastClick = e.timeStamp;
    return;
  }
  lastClick = 0;
  api.invoke("expand_from_ball").catch(console.error);
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

api.listen("ball-update", render);
render();
