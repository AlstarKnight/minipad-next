// ---------- 全局颜色预设和共用的多节点编辑器 ----------
// 所有颜色入口使用同一份 settings.color_presets；旧版笔记本预设只导入一次。
import { state } from "./state.js";
import { GRADIENTS, parseAccent, tidyAccent, gradientOf } from "./accent.js";
import { toast, ask } from "./ui.js";

const QUICK = 5;
const kindOf = (color) => parseAccent(color)?.to ? "gradient" : "solid";
// 快捷色上限：正整数，最多和颜色库一样 128 个；0（空着）表示不限。
export const quickLimit = (value) => {
  const n = Math.round(Number(value));
  return n >= 1 ? Math.min(128, n) : 0;
};

// 精选的默认库：15 个纯色、24 个不重复的渐变。
const ADDED_GRADIENTS = GRADIENTS.slice(12).map((g) => gradientOf(g.stops));
export const DEFAULT_COLORS = [
  "#d9822b", "#3b82f6", "#16a34a", "#8b5cf6", "#e5484d",
  "#ec4899", "#8a8f98", "#df2a3f", "#117cee", "#1f9c58",
  "#c99a06", "#fbe9a6", "#d3e6fd", "#d2f1d9", "#e6dbf8",
  ...[0, 1, 2, 3, 5, 7, 9, 10, 11].map((i) => gradientOf(GRADIENTS[i].stops)),
  ...ADDED_GRADIENTS,
];
// 内置颜色的版本：1 = 0.3.11 加的渐变。旧颜色库只补一次，之后删掉的不会再回来。
const COLOR_REV = 1;
export const sharedColorPresets = () => state.settings?.color_library ??
  [...new Set([...DEFAULT_COLORS, ...(state.settings?.color_presets ?? state.settings?.book_color_presets ?? [])])];
// 快捷色单独保存（quick_colors），不占颜色库里的位置：移出快捷栏就回到原来的地方。
// 旧设置没有 quick_colors 时沿用颜色库的前 quick_color_count 个。limit 为 0 表示不限。
export const quickColors = (limit = quickLimit(state.settings?.quick_color_limit)) => {
  const library = sharedColorPresets();
  const saved = state.settings?.quick_colors;
  const list = Array.isArray(saved) ? saved.filter((color) => library.includes(color))
    : library.slice(0, Math.max(1, Math.round(Number(state.settings?.quick_color_count) || QUICK)));
  return limit ? list.slice(0, limit) : list;
};

const live = new Set();
export function refreshSharedColors() {
  for (const tool of live) {
    if (tool.root.isConnected) tool.refreshPresets();
    else live.delete(tool);
  }
}
let presetQueue = Promise.resolve();
// change(颜色库, 快捷色) 返回 { library?, quick? }，null 表示不用保存。
// limit 是这次操作时看到的快捷色上限（设置页里可能是还没保存的预览值）。
function updateLibrary(change, limit = 0) {
  // 每次从最新已保存的颜色库计算，快速连续操作不会丢失修改。
  const task = presetQueue.then(async () => {
    const next = change(sharedColorPresets(), quickColors(limit));
    if (next === null) return;
    const library = next.library ?? sharedColorPresets();
    const quick = [...new Set(next.quick ?? quickColors(0))].filter((color) => library.includes(color));
    const { saveSettings } = await import("./settings.js");
    await saveSettings({ ...state.settings, color_library: library, quick_colors: quick, color_library_rev: COLOR_REV });
    refreshSharedColors();
  });
  presetQueue = task.catch(() => {});
  return task;
}
// 把 color 挪到 target 原来的位置：往后挪落在它后面，往前挪落在它前面。
const moved = (list, color, target) => {
  const next = list.filter((entry) => entry !== color);
  const at = next.indexOf(target);
  next.splice(at < 0 ? next.length : at + (list.indexOf(color) < list.indexOf(target) ? 1 : 0), 0, color);
  return next;
};
// 把 color 放到 target 前面；target 为空时放到最后。
const before = (list, color, target) => {
  const next = list.filter((entry) => entry !== color);
  const at = target ? next.indexOf(target) : -1;
  next.splice(at < 0 ? next.length : at, 0, color);
  return next;
};
export function changeSharedPreset(value, remove = false) {
  const normalized = tidyAccent(value);
  if (!normalized) return Promise.reject(new Error("颜色格式无效"));
  return updateLibrary((old) => {
    if (!remove && old.includes(normalized)) return null;
    if (!remove && old.length >= 128) throw new Error("颜色库最多保存 128 个颜色");
    return { library: remove ? old.filter((c) => c !== normalized) : [...old, normalized] };
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
    // 快捷栏里的也换成新颜色，位置不变
    const quick = quickColors(0).map((color) => color === oldValue ? normalized : color);
    return { library: next, quick };
  });
}
export const resetSharedPresets = () =>
  updateLibrary(() => ({ library: [...DEFAULT_COLORS], quick: DEFAULT_COLORS.slice(0, QUICK) }));
// 颜色库里的按钮和设置→外观里的按钮共用；返回是否真的恢复了。
export const askResetColors = () =>
  ask("确定恢复默认颜色库？自己添加或编辑的颜色会从颜色库中移除，快捷色也恢复默认；已经使用的颜色不会改变。", "恢复默认", true, true)
    .then((confirmed) => confirmed && resetSharedPresets().then(() => { toast("已恢复默认颜色库"); return true; }));
export const restoreSharedPreset = (color, index) => updateLibrary((colors) => {
  if (colors.includes(color)) return null;
  const next = [...colors];
  next.splice(Math.min(Math.max(index, 0), colors.length), 0, color);
  return { library: next };
});
export const restoreQuickColor = (color, index) => updateLibrary((colors) => {
  const quick = quickColors(0);
  if (!colors.includes(color) || quick.includes(color)) return null;
  quick.splice(Math.min(Math.max(index, 0), quick.length), 0, color);
  return { quick };
});
// 启动时给旧颜色库补上新版本的内置渐变（只补一次）。
export async function upgradeColorLibrary() {
  const s = state.settings;
  if (!s || !Array.isArray(s.color_library) || (Number(s.color_library_rev) || 0) >= COLOR_REV) return;
  await updateLibrary((library) => ({
    library: [...library, ...ADDED_GRADIENTS.filter((color) => !library.includes(color))].slice(0, 128),
  }));
}
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
export function makeSharedColorTools({ getValue, onApply, defaultColor = "#d9822b", allowGradient = true, showPresets = true, compact = false, previewMode = "color", getQuickLimit } = {}) {
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
  const reset = make("button", "small uc-reset", "恢复默认颜色库");
  reset.type = "button";
  reset.title = "恢复内置颜色和快捷色，已应用的颜色不受影响";
  if (compact) {
    edit.textContent = "自定义…";
    edit.title = "自定义颜色 / 渐变节点";
    edit.setAttribute("aria-label", "自定义颜色 / 渐变节点");
    save.textContent = "保存";
    save.title = "保存当前颜色";
    save.setAttribute("aria-label", "保存当前颜色");
    reset.textContent = "恢复默认";
    reset.setAttribute("aria-label", "恢复默认颜色库");
  }
  const undo = make("button", "small uc-undo", "撤销删除");
  undo.type = "button";
  undo.hidden = true;
  actions.append(edit, save, undo, reset);
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
  const add = make("button", "small", "+ 添加节点");
  add.type = "button";
  const apply = make("button", "small primary", "应用颜色");
  apply.type = "button";
  footer.append(add, apply);
  editor.append(controls, preview, stopList, footer);
  root.append(heading, buttons, actions, editor);
  let refreshPresets = () => {};
  const expand = (opened) => {
    buttons.classList.toggle("expanded", opened);
    root.classList.toggle("library-open", opened);
    actions.hidden = !opened;
    if (!opened) {
      editor.hidden = true;
      editingPreset = null;
      edit.setAttribute("aria-expanded", "false");
    }
    more.textContent = opened ? "−" : "＋";
    more.title = opened ? "收起颜色库" : "更多颜色及排序";
    more.setAttribute("aria-label", more.title);
    more.setAttribute("aria-expanded", String(opened));
    refreshPresets();
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
    const popup = root.closest(".fb-pop");
    if (popup) requestAnimationFrame(() => {
      if (popup.hidden || editor.hidden) return;
      popup.style.top = Math.max(4, Math.min(
        Number.parseFloat(popup.style.top) || 4,
        window.innerHeight - popup.offsetHeight - 4
      )) + "px";
      popup.scrollTop = popup.scrollHeight;
    });
  };
  refreshPresets = () => {
    const active = document.activeElement;
    const focusColor = buttons.contains(active) && active.classList.contains("uc-swatch") ? active.dataset.color : null;
    const focusMore = active === more;
    buttons.replaceChildren();
    const presets = sharedColorPresets();
    const expanded = buttons.classList.contains("expanded");
    // 快捷色单独保存，在颜色库里的位置不变；分区里不重复显示快捷色。
    // 个数随拖进、移出增减，不超过设置里的上限（设置页打开时按正在填的上限预览）。
    const limit = quickLimit(getQuickLimit?.() ?? state.settings?.quick_color_limit);
    const quickList = quickColors(limit);
    buttons.style.setProperty("--uc-toggle-column", String(quickList.length ? Math.min(quickList.length, 5) + 1 : 6));
    buttons.style.setProperty("--uc-quick-rows", String(Math.max(1, Math.ceil(quickList.length / 6))));
    const remainder = presets.filter((color) => !quickList.includes(color));
    const sections = expanded ? [
      { kind: "quick", title: "快捷（收起时显示）", colors: quickList },
      { kind: "solid", title: "纯色", colors: remainder.filter((color) => kindOf(color) === "solid") },
      { kind: "gradient", title: "渐变色", colors: remainder.filter((color) => kindOf(color) === "gradient") },
    ] : [{ kind: "quick", colors: quickList }];
    let draggingColor = null;
    const sectionOf = (value) => {
      const quick = quickColors(limit);
      if (quick.includes(value)) return "quick";
      return sharedColorPresets().includes(value) ? kindOf(value) : null;
    };
    const canDrop = (value, targetSection, targetColor = null) => {
      if (!sectionOf(value) || value === targetColor) return false;
      // 分类间的拖放无意义；快捷色只能退回到自己的颜色类型。
      return targetSection === "quick" || kindOf(value) === targetSection;
    };
    const dropAt = (value, targetSection, targetColor = null) => {
      if (!canDrop(value, targetSection, targetColor)) return;
      void updateLibrary((library, quick) => {
        if (targetSection === "quick") {
          // 拖进快捷区多一个；到上限时挤掉最后一个（不是刚拖进来的这个），它回到原来的位置。
          const next = quick.includes(value) ? moved(quick, value, targetColor) : before(quick, value, targetColor);
          while (limit && next.length > limit) next.splice(next.at(-1) === value ? -2 : -1, 1);
          return { quick: next };
        }
        const rest = quick.filter((color) => color !== value);
        // 拖到分类标题：快捷色回到原来的位置；分类里的颜色排到这一类最前面。
        const first = library.find((color) => color !== value && !rest.includes(color) && kindOf(color) === targetSection);
        const next = targetColor ? moved(library, value, targetColor) :
          quick.includes(value) || !first ? library : before(library, value, first);
        return { library: next, quick: rest };
      }, limit).catch((err) => toast(String(err)));
    };
    if (!presets.length) buttons.append(make("span", "muted", "还没有保存的颜色"));
    else if (!quickList.length && !expanded) buttons.append(make("span", "muted", "点 ＋ 把颜色拖进快捷栏"));
    for (const section of sections) {
      if (expanded && (section.kind === "quick" || section.colors.length ||
        quickList.some((color) => kindOf(color) === section.kind))) {
        const label = make("div", "uc-kind-title" + (section.kind === "quick" ? " first" : ""),
          section.title);
        label.dataset.section = section.kind;
        label.setAttribute("role", "heading");
        label.setAttribute("aria-level", "3");
        label.title = section.kind === "quick" ? "将颜色拖到此处设为快捷色" : "将同类快捷颜色拖到此处移出快捷栏";
        label.addEventListener("dragover", (e) => {
          if (!draggingColor || !canDrop(draggingColor, section.kind)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });
        label.addEventListener("drop", (e) => {
          if (!draggingColor || !canDrop(draggingColor, section.kind)) return;
          e.preventDefault();
          dropAt(draggingColor, section.kind);
        });
        buttons.append(label);
      }
      for (const color of section.colors) {
        const parsed = parseAccent(color);
        if (!parsed) continue;
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
          if (parsed.to) swatch.style.setProperty("--uc-text-gradient", color);
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
          const group = sharedColorPresets().filter((entry) => sectionOf(entry) === section.kind);
          const ordered = section.kind === "quick" ? quickColors(limit) : group;
          const next = ordered[ordered.indexOf(color) + (e.key === "ArrowLeft" ? -1 : 1)];
          if (!next) return;
          void updateLibrary((library, quick) => section.kind === "quick"
            ? { quick: moved(quick, color, next) } : { library: moved(library, color, next) }, limit)
            .then(() => [...buttons.querySelectorAll(".uc-swatch")].find((x) => x.dataset.color === color)?.focus())
            .catch((err) => toast(String(err)));
        });
        wrap.addEventListener("dragstart", (e) => {
          draggingColor = color;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", color);
        });
        wrap.addEventListener("dragend", () => { draggingColor = null; });
        wrap.addEventListener("dragover", (e) => {
          if (!buttons.classList.contains("expanded") || !canDrop(draggingColor, section.kind, color)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });
        wrap.addEventListener("drop", (e) => {
          if (!buttons.classList.contains("expanded") || !canDrop(draggingColor, section.kind, color)) return;
          e.preventDefault();
          dropAt(draggingColor, section.kind, color);
        });
        swatch.title += "；双击或右键编辑，F2 键也可编辑";
        const editColor = () => {
          if (!buttons.classList.contains("expanded")) expand(true);
          openEditor(color, color);
        };
        swatch.addEventListener("dblclick", editColor);
        swatch.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          editColor();
        });
        swatch.addEventListener("keydown", (e) => {
          if (e.key === "F2") {
            e.preventDefault();
            editColor();
          }
        });
        const remove = make("button", "uc-delete", "×");
        remove.type = "button"; remove.title = "删除颜色预设";
        remove.setAttribute("aria-label", "删除保存的颜色 " + color);
        // 快捷栏里的 × 只是移出快捷栏，颜色回到原来的位置；分类里的 × 才从颜色库删除。
        const fromQuick = section.kind === "quick";
        if (fromQuick) {
          remove.title = "移出快捷栏（回到原来的位置）";
          remove.setAttribute("aria-label", "移出快捷栏 " + color);
        }
        remove.addEventListener("click", () => {
          const index = (fromQuick ? quickColors(0) : sharedColorPresets()).indexOf(color);
          const operation = fromQuick
            ? updateLibrary((library, quick) => ({ quick: quick.filter((entry) => entry !== color) }), limit)
            : changeSharedPreset(color, true);
          void operation.then(() => {
            lastDeleted = { color, index, quick: fromQuick };
            undo.textContent = fromQuick ? "撤销移出" : "撤销删除";
            undo.hidden = false;
            toast(fromQuick ? "已移出快捷栏，可点击“撤销移出”" : "已删除颜色，可点击“撤销删除”");
          }).catch((err) => toast(String(err)));
        });
        wrap.append(swatch, remove);
        buttons.append(wrap);
      }
    }
    buttons.append(more);
    more.hidden = !showPresets;
    if (focusMore) more.focus();
    else if (focusColor) [...buttons.querySelectorAll(".uc-swatch")]
      .find((swatch) => swatch.dataset.color === focusColor)?.focus();
  };
  undo.addEventListener("click", () => {
    if (!lastDeleted) return;
    const { color, index, quick } = lastDeleted;
    void (quick ? restoreQuickColor(color, index) : restoreSharedPreset(color, index)).then(() => {
      lastDeleted = null;
      undo.hidden = true;
      toast(quick ? "已撤销移出" : "已撤销删除");
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
  reset.addEventListener("click", () => void askResetColors().then((done) => {
    if (done) { editor.hidden = true; editingPreset = null; edit.setAttribute("aria-expanded", "false"); }
  }).catch((e) => toast(String(e))));
  const tool = { root, refreshPresets, sync: () => { if (!editor.hidden && !editingPreset) startEditing(); refreshPresets(); } };
  for (const stale of live) if (!stale.root.isConnected) live.delete(stale);
  live.add(tool);
  refreshPresets();
  return tool;
}
