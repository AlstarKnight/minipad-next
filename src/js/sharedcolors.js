// ---------- 全局颜色预设和共用的多节点编辑器 ----------
// 所有颜色入口使用同一份 settings.color_presets；旧版笔记本预设只导入一次。
import { state } from "./state.js";
import { parseAccent, tidyAccent, gradientOf } from "./accent.js";
import { toast } from "./ui.js";

export const sharedColorPresets = () =>
  state.settings?.color_presets ?? state.settings?.book_color_presets ?? [];

const live = new Set();
export function refreshSharedColors() {
  for (const tool of live) {
    if (tool.root.isConnected) tool.refreshPresets();
    else live.delete(tool);
  }
}
export async function changeSharedPreset(value, remove = false) {
  const normalized = tidyAccent(value);
  if (!normalized) throw new Error("颜色格式无效");
  const old = sharedColorPresets();
  if (!remove && old.includes(normalized)) return;
  if (!remove && old.length >= 20) throw new Error("最多保存 20 个颜色预设");
  const next = remove ? old.filter((c) => c !== normalized) : [...old, normalized];
  const { saveSettings } = await import("./settings.js");
  await saveSettings({ ...state.settings, color_presets: next });
  refreshSharedColors();
}
const make = (tag, cls = "", label = "") => {
  const node = document.createElement(tag);
  node.className = cls;
  if (label) node.textContent = label;
  return node;
};
const percentage = (i, count) => Math.round((i / Math.max(count - 1, 1)) * 100);

/** 返回可挂到任意容器的通用“我的颜色 + 多节点编辑器”。
 *  onApply 可以是异步函数；只有用户主动点击应用才更新目标设置。
 */
export function makeSharedColorTools({ getValue, onApply, defaultColor = "#d9822b", allowGradient = true, showPresets = true } = {}) {
  const root = make("section", "shared-colors");
  const heading = make("div", "uc-title", "我的颜色");
  const buttons = make("div", "uc-presets");
  const actions = make("div", "uc-actions");
  const edit = make("button", "small", "自定义颜色 / 渐变节点");
  edit.type = "button";
  edit.setAttribute("aria-expanded", "false");
  const save = make("button", "small", "保存当前颜色");
  save.type = "button";
  actions.append(edit, save);
  const editor = make("div", "uc-editor");
  editor.hidden = true;
  const controls = make("div", "uc-controls");
  const mode = make("select");
  mode.setAttribute("aria-label", "颜色类型");
  for (const [value, label] of [["solid", "纯色"], ["gradient", "渐变"]]) {
    if (!allowGradient && value === "gradient") continue;
    const opt = make("option", "", label);
    opt.value = value;
    mode.append(opt);
  }
  const angleLabel = make("label", "uc-angle", "角度 ");
  const angle = make("input");
  angle.type = "number";
  angle.min = "0";
  angle.max = "360";
  angle.value = "135";
  angle.setAttribute("aria-label", "渐变角度");
  angleLabel.append(angle, "°");
  controls.append(mode, angleLabel);
  const preview = make("div", "uc-preview");
  preview.setAttribute("aria-label", "颜色预览");
  const stopList = make("div", "uc-stops");
  const footer = make("div", "uc-actions");
  const add = make("button", "small", "+ 添加节点");
  add.type = "button";
  const apply = make("button", "small primary", "应用颜色");
  apply.type = "button";
  footer.append(add, apply);
  editor.append(controls, preview, stopList, footer);
  root.append(heading, buttons, actions, editor);
  if (!showPresets) {
    heading.hidden = true;
    buttons.hidden = true;
    save.hidden = true;
  }

  let stops = [{ color: defaultColor, pos: 0 }];
  const current = () => tidyAccent(getValue?.() || "") || defaultColor;
  const startEditing = () => {
    const parsed = parseAccent(current()) || parseAccent(defaultColor);
    mode.value = parsed?.to && allowGradient ? "gradient" : "solid";
    angle.value = String(parsed?.deg ?? 135);
    const colors = parsed?.stops || [defaultColor];
    stops = colors.map((color, i) => ({ color, pos: parsed?.positions?.[i] ?? percentage(i, colors.length) }));
    if (mode.value === "gradient" && stops.length === 1) stops.push({ color: "#d66cf0", pos: 100 });
    paintStops();
  };
  const value = () => mode.value === "gradient"
    ? gradientOf(stops.map((x) => x.color), Number(angle.value) || 0, stops.map((x) => x.pos))
    : stops[0]?.color || defaultColor;
  const paintPreview = () => { preview.style.background = value(); };
  const paintStops = () => {
    angleLabel.hidden = mode.value !== "gradient";
    add.hidden = mode.value !== "gradient";
    stopList.replaceChildren();
    if (mode.value === "gradient" && stops.length === 1) stops.push({ color: "#d66cf0", pos: 100 });
    stops.forEach((stop, i) => {
      if (mode.value === "solid" && i) return;
      const row = make("div", "uc-stop");
      const color = make("input");
      color.type = "color";
      color.value = stop.color;
      color.setAttribute("aria-label", "节点 " + (i + 1) + " 颜色");
      color.addEventListener("input", () => { stop.color = color.value; paintPreview(); });
      row.append(color);
      if (mode.value === "gradient") {
        const position = make("input");
        position.type = "number";
        position.min = "0"; position.max = "100"; position.step = "1";
        position.value = String(stop.pos);
        position.setAttribute("aria-label", "节点 " + (i + 1) + " 位置");
        position.addEventListener("change", () => {
          const previous = i ? stops[i - 1].pos : 0;
          const following = i + 1 < stops.length ? stops[i + 1].pos : 100;
          stop.pos = Math.max(previous, Math.min(following, Number(position.value) || 0));
          position.value = String(stop.pos);
          paintPreview();
        });
        row.append(position, "%");
        const remove = make("button", "small uc-remove", "×");
        remove.type = "button"; remove.title = "删除节点";
        remove.disabled = stops.length <= 2;
        remove.addEventListener("click", () => { if (stops.length > 2) { stops.splice(i, 1); paintStops(); } });
        row.append(remove);
      }
      stopList.append(row);
    });
    paintPreview();
  };
  const refreshPresets = () => {
    buttons.replaceChildren();
    const presets = sharedColorPresets();
    if (!presets.length) {
      const hint = make("span", "muted", "还没有保存的颜色");
      buttons.append(hint);
    }
    for (const color of presets) {
      if (!parseAccent(color)) continue;
      const wrap = make("div", "uc-preset");
      const swatch = make("button", "uc-swatch");
      swatch.type = "button";
      swatch.title = "使用 " + color;
      swatch.setAttribute("aria-label", "使用保存的颜色 " + color);
      swatch.style.background = color;
      swatch.addEventListener("click", () => void Promise.resolve(onApply(color)).catch((e) => toast(String(e))));
      const remove = make("button", "uc-delete", "×");
      remove.type = "button"; remove.title = "删除颜色预设";
      remove.setAttribute("aria-label", "删除保存的颜色 " + color);
      remove.addEventListener("click", () =>
        void changeSharedPreset(color, true).catch((e) => toast(String(e))));
      wrap.append(swatch, remove);
      buttons.append(wrap);
    }
  };
  edit.addEventListener("click", () => {
    editor.hidden = !editor.hidden;
    edit.setAttribute("aria-expanded", String(!editor.hidden));
    if (!editor.hidden) startEditing();
  });
  save.addEventListener("click", () =>
    void changeSharedPreset(editor.hidden ? current() : value()).then(() => toast("颜色预设已保存")).catch((e) => toast(String(e))));
  mode.addEventListener("change", () => { paintStops(); });
  angle.addEventListener("change", () => { angle.value = String(Math.max(0, Math.min(360, Number(angle.value) || 0))); paintPreview(); });
  add.addEventListener("click", () => {
    if (stops.length >= 7) return toast("渐变最多 7 个颜色节点");
    const index = Math.max(1, stops.length - 1);
    const left = stops[index - 1], right = stops[index];
    stops.splice(index, 0, { color: left.color, pos: Math.round((left.pos + right.pos) / 2) });
    paintStops();
  });
  apply.addEventListener("click", () =>
    void Promise.resolve(onApply(value())).then(() => { editor.hidden = true; edit.setAttribute("aria-expanded", "false"); }).catch((e) => toast(String(e))));
  const tool = { root, refreshPresets, sync: () => { if (!editor.hidden) startEditing(); refreshPresets(); } };
  live.add(tool);
  refreshPresets();
  return tool;
}
