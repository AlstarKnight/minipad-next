// ---------- 全局颜色预设和共用的多节点编辑器 ----------
// 所有颜色入口使用同一份 settings.color_presets；旧版笔记本预设只导入一次。
import { state } from "./state.js";
import { GRADIENTS, parseAccent, tidyAccent, gradientOf } from "./accent.js";
import { toast, ask } from "./ui.js";

// 精选的默认库：15 个纯色、9 个不重复的渐变。
export const DEFAULT_COLORS = [
  "#d9822b", "#3b82f6", "#16a34a", "#8b5cf6", "#e5484d",
  "#ec4899", "#8a8f98", "#df2a3f", "#117cee", "#1f9c58",
  "#c99a06", "#fbe9a6", "#d3e6fd", "#d2f1d9", "#e6dbf8",
  ...[0, 1, 2, 3, 5, 7, 9, 10, 11].map((i) => gradientOf(GRADIENTS[i].stops)),
];
export const sharedColorPresets = () => state.settings?.color_library ??
  [...new Set([...DEFAULT_COLORS, ...(state.settings?.color_presets ?? state.settings?.book_color_presets ?? [])])];

const live = new Set();
export function refreshSharedColors() {
  for (const tool of live) {
    if (tool.root.isConnected) tool.refreshPresets();
    else live.delete(tool);
  }
}
let presetQueue = Promise.resolve();
function updateLibrary(change) {
  // 每次从最新已保存的颜色库计算，快速连续操作不会丢失修改。
  const task = presetQueue.then(async () => {
    const next = change(sharedColorPresets());
    if (next === null) return;
    const { saveSettings } = await import("./settings.js");
    await saveSettings({ ...state.settings, color_library: next });
    refreshSharedColors();
  });
  presetQueue = task.catch(() => {});
  return task;
}
export function changeSharedPreset(value, remove = false) {
  const normalized = tidyAccent(value);
  if (!normalized) return Promise.reject(new Error("颜色格式无效"));
  return updateLibrary((old) => {
    if (!remove && old.includes(normalized)) return null;
    if (!remove && old.length >= 128) throw new Error("颜色库最多保存 128 个颜色");
    return remove ? old.filter((c) => c !== normalized) : [...old, normalized];
  });
}
export function replaceSharedPreset(oldValue, newValue) {
  const normalized = tidyAccent(newValue);
  if (!normalized) return Promise.reject(new Error("颜色格式无效"));
  return updateLibrary((old) => {
    const index = old.indexOf(oldValue);
    if (index < 0) throw new Error("待编辑的颜色已被删除");
    const next = old.filter((color) => color !== oldValue && color !== normalized);
    next.splice(Math.min(index, next.length), 0, normalized);
    return next;
  });
}
export const resetSharedPresets = () => updateLibrary(() => [...DEFAULT_COLORS]);
export const moveSharedPreset = (color, target) => updateLibrary((colors) => {
  const from = colors.indexOf(color);
  if (from < 0 || target < 0 || target >= colors.length || from === target) return null;
  const next = [...colors];
  next.splice(target, 0, ...next.splice(from, 1));
  return next;
});
export const restoreSharedPreset = (color, index) => updateLibrary((colors) => {
  if (colors.includes(color)) return null;
  const next = [...colors];
  next.splice(Math.min(Math.max(index, 0), colors.length), 0, color);
  return next;
});
const make = (tag, cls = "", label = "") => {
  const node = document.createElement(tag);
  node.className = cls;
  if (label) node.textContent = label;
  return node;
};
const percentage = (i, count) => Math.round((i / Math.max(count - 1, 1)) * 100);
const lightText = (value) => (parseAccent(value)?.stops || []).some((hex) => {
  const rgb = hex.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!rgb) return false;
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(rgb.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.45;
});

/** 返回可挂到任意容器的通用“我的颜色 + 多节点编辑器”。
 *  onApply 可以是异步函数；只有用户主动点击应用才更新目标设置。
 */
export function makeSharedColorTools({ getValue, onApply, defaultColor = "#d9822b", allowGradient = true, showPresets = true, compact = false, previewMode = "color" } = {}) {
  const root = make("section", compact ? "shared-colors compact" : "shared-colors");
  const heading = make("div", "uc-title", "颜色库");
  const buttons = make("div", "uc-presets");
  const more = make("button", "uc-more", "＋");
  more.type = "button";
  more.title = "展开颜色库，拖动排序";
  more.setAttribute("aria-label", "更多颜色及排序");
  more.setAttribute("aria-expanded", "false");
  const actions = make("div", "uc-actions");
  const edit = make("button", "small", "自定义颜色 / 渐变节点");
  edit.type = "button";
  edit.setAttribute("aria-expanded", "false");
  const save = make("button", "small", "保存当前颜色");
  save.type = "button";
  if (compact) {
    edit.textContent = "自定义…";
    edit.title = "自定义颜色 / 渐变节点";
    edit.setAttribute("aria-label", "自定义颜色 / 渐变节点");
    save.textContent = "保存";
    save.title = "保存当前颜色";
    save.setAttribute("aria-label", "保存当前颜色");
  }
  const undo = make("button", "small uc-undo", "撤销删除");
  undo.type = "button";
  undo.hidden = true;
  actions.append(edit, save, undo);
  let lastDeleted = null;
  let editingPreset = null;
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
  const reset = make("button", "small uc-reset", "恢复默认颜色");
  reset.type = "button";
  reset.title = "恢复内置颜色，已应用的颜色不受影响";
  const add = make("button", "small", "+ 添加节点");
  add.type = "button";
  const apply = make("button", "small primary", "应用颜色");
  apply.type = "button";
  footer.append(add, apply, reset);
  editor.append(controls, preview, stopList, footer);
  root.append(heading, buttons, actions, editor);
  const expand = (opened) => {
    buttons.classList.toggle("expanded", opened);
    root.classList.toggle("library-open", opened);
    actions.hidden = !opened;
    if (!opened) {
      editor.hidden = true;
      editingPreset = null;
      edit.setAttribute("aria-expanded", "false");
    }
    more.textContent = opened ? "收起" : "＋";
    more.title = opened ? "收起颜色库" : "更多颜色及排序";
    more.setAttribute("aria-expanded", String(opened));
  };
  more.addEventListener("click", () => expand(!buttons.classList.contains("expanded")));
  expand(false);
  if (!showPresets) {
    heading.hidden = true;
    buttons.hidden = true;
    save.hidden = true;
  }

  let stops = [{ color: defaultColor, pos: 0 }];
  const current = () => tidyAccent(getValue?.() || "") || defaultColor;
  const startEditing = (from = current()) => {
    const parsed = parseAccent(from) || parseAccent(defaultColor);
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
  const openEditor = (from, preset = null) => {
    editingPreset = preset;
    editor.hidden = false;
    edit.setAttribute("aria-expanded", "true");
    apply.textContent = preset ? "保存修改" : "应用颜色";
    startEditing(from);
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
      wrap.draggable = true;
      wrap.dataset.color = color;
      wrap.title = "拖动排序；焦点在色块上时可按 Shift+左右箭头排序";
      const swatch = make("button", "uc-swatch");
      swatch.dataset.color = color;
      swatch.type = "button";
      swatch.classList.toggle("on", color === current());
      swatch.title = "使用 " + color;
      swatch.setAttribute("aria-label", "使用保存的颜色 " + color);
      if (previewMode === "text") {
        swatch.classList.add("uc-text-swatch");
        swatch.textContent = "A";
        if (parseAccent(color)?.to) swatch.style.setProperty("--uc-text-gradient", color);
        else swatch.style.color = color;
        if (lightText(color)) {
          swatch.title += "（浅色主题下文字对比度较低）";
          swatch.dataset.contrastWarning = "light-text";
        }
      } else {
        swatch.style.background = color;
        if (previewMode === "background") swatch.title += "（深色背景可能影响文字对比度）";
      }
      swatch.addEventListener("click", () => void Promise.resolve(onApply(color)).catch((e) => toast(String(e))));
      swatch.addEventListener("keydown", (e) => {
        if (!e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        const index = sharedColorPresets().indexOf(color);
        void moveSharedPreset(color, index + (e.key === "ArrowLeft" ? -1 : 1))
          .then(() => [...buttons.querySelectorAll(".uc-swatch")].find((x) => x.dataset.color === color)?.focus())
          .catch((err) => toast(String(err)));
      });
      wrap.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", color);
      });
      wrap.addEventListener("dragover", (e) => {
        if (!buttons.classList.contains("expanded")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      wrap.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!buttons.classList.contains("expanded")) return;
        const dragged = e.dataTransfer.getData("text/plain");
        if (!sharedColorPresets().includes(dragged)) return;
        void moveSharedPreset(dragged, sharedColorPresets().indexOf(color))
          .catch((err) => toast(String(err)));
      });
      swatch.title += "；双击或右键编辑，F2 键也可编辑";
      swatch.addEventListener("dblclick", () => openEditor(color, color));
      swatch.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (buttons.classList.contains("expanded")) openEditor(color, color);
      });
      swatch.addEventListener("keydown", (e) => {
        if (e.key === "F2" && buttons.classList.contains("expanded")) {
          e.preventDefault();
          openEditor(color, color);
        }
      });
      const remove = make("button", "uc-delete", "×");
      remove.type = "button"; remove.title = "删除颜色预设";
      remove.setAttribute("aria-label", "删除保存的颜色 " + color);
      remove.addEventListener("click", () => {
        const index = sharedColorPresets().indexOf(color);
        void changeSharedPreset(color, true).then(() => {
          lastDeleted = { color, index };
          undo.hidden = false;
          toast("已删除颜色，可点击“撤销删除”");
        }).catch((err) => toast(String(err)));
      });
      wrap.append(swatch, remove);
      buttons.append(wrap);
    }
    buttons.append(more);
    more.hidden = !showPresets;
  };
  undo.addEventListener("click", () => {
    if (!lastDeleted) return;
    const { color, index } = lastDeleted;
    void restoreSharedPreset(color, index).then(() => {
      lastDeleted = null;
      undo.hidden = true;
      toast("已撤销删除");
    }).catch((err) => toast(String(err)));
  });
  edit.addEventListener("click", () => {
    if (editor.hidden) openEditor(current());
    else { editor.hidden = true; editingPreset = null; edit.setAttribute("aria-expanded", "false"); }
  });
  save.addEventListener("click", () => {
    const operation = editingPreset
      ? replaceSharedPreset(editingPreset, value())
      : changeSharedPreset(editor.hidden ? current() : value());
    void operation.then(() => {
      editor.hidden = true; editingPreset = null; edit.setAttribute("aria-expanded", "false");
      toast("颜色库已保存");
    }).catch((e) => toast(String(e)));
  });
  mode.addEventListener("change", () => { paintStops(); });
  angle.addEventListener("change", () => { angle.value = String(Math.max(0, Math.min(360, Number(angle.value) || 0))); paintPreview(); });
  add.addEventListener("click", () => {
    if (stops.length >= 7) return toast("渐变最多 7 个颜色节点");
    const index = Math.max(1, stops.length - 1);
    const left = stops[index - 1], right = stops[index];
    stops.splice(index, 0, { color: left.color, pos: Math.round((left.pos + right.pos) / 2) });
    paintStops();
  });
  apply.addEventListener("click", () => {
    const operation = editingPreset ? replaceSharedPreset(editingPreset, value()) : Promise.resolve(onApply(value()));
    void operation.then(() => {
      editor.hidden = true; editingPreset = null; edit.setAttribute("aria-expanded", "false");
    }).catch((e) => toast(String(e)));
  });
  reset.addEventListener("click", () =>
    void ask("确定恢复默认颜色库？自己添加或编辑的预设将从颜色库中移除，已经使用的颜色不会改变。", "恢复默认", true, true)
      .then((confirmed) => confirmed && resetSharedPresets().then(() => {
        editor.hidden = true; editingPreset = null; edit.setAttribute("aria-expanded", "false");
        toast("已恢复默认颜色库");
      })).catch((e) => toast(String(e))));
  const tool = { root, refreshPresets, sync: () => { if (!editor.hidden && !editingPreset) startEditing(); refreshPresets(); } };
  for (const stale of live) if (!stale.root.isConnected) live.delete(stale);
  live.add(tool);
  refreshPresets();
  return tool;
}
