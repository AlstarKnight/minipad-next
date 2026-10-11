// ---------- 后端接口(在浏览器里打开时用 localStorage 模拟,方便预览界面) ----------
import { mockApi } from "./mock.js";

const TAURI = window.__TAURI__;

export const isMock = !TAURI;

// 模拟后端第一次用到时才建
let mock = null;
const getMock = () => (mock ||= mockApi());

export const api = TAURI
  ? {
      invoke: (cmd, args) => TAURI.core.invoke(cmd, args),
      listen: (ev, cb) => TAURI.event.listen(ev, cb),
    }
  : {
      invoke: (cmd, args) => getMock().invoke(cmd, args),
      listen: (ev, cb) => getMock().listen(ev, cb),
    };
