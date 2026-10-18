// ---------- 后端接口(在浏览器里打开时用 localStorage 模拟,方便预览界面) ----------
import { mockApi } from "./mock.js";

const TAURI = window.__TAURI__;

export const isMock = !TAURI;

// 这个窗口是小窗(只放一页,见 mini.js);浏览器预览里用 ?mini=1&book=&page= 模拟
export const isMiniWindow = TAURI
  ? !!TAURI.webviewWindow?.getCurrentWebviewWindow?.().label?.startsWith("mini-")
  : new URLSearchParams(location.search).has("mini");

// 模拟后端第一次用到时才建
let mock = null;
const getMock = () => (mock ||= mockApi());

export const api = TAURI
  ? {
      // options:{ headers }(二进制参数时用,比如存图片)
      invoke: (cmd, args, options) => TAURI.core.invoke(cmd, args, options),
      // 只收发给这个窗口的和发给所有窗口的事件(主窗口和小窗各收各的)
      listen: (ev, cb) => TAURI.webviewWindow.getCurrentWebviewWindow().listen(ev, cb),
    }
  : {
      invoke: (cmd, args, options) => getMock().invoke(cmd, args, options),
      listen: (ev, cb) => getMock().listen(ev, cb),
    };
