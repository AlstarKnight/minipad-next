// ---------- 全局颜色库和共用的多节点编辑器 ----------
// 所有颜色入口共用三个库：纯色、渐变（都在 settings.color_library 里，按颜色本身分）、
// 材质（settings.material_library，也是渐变写法，所以单独存）。每一类有自己的快捷栏，
// 快捷色合在 settings.quick_colors 里，按类型过滤出每一类。
import { state } from "./state.js";
import { GRADIENTS, parseAccent, tidyAccent, gradientOf } from "./accent.js";
import { toast, ask } from "./ui.js";

const QUICK = 5;
const KINDS = ["solid", "gradient", "material"];
const KIND_NAME = { solid: "纯色", gradient: "渐变", material: "材质" };
const KIND_LIBRARY = { solid: "纯色", gradient: "渐变色", material: "材质色" };
// 每一类最多 128 个颜色
const MAX = 128;
// 快捷色上限：正整数，最多 128 个；0（空着）表示不限。
export const quickLimit = (value) => {
  const n = Math.round(Number(value));
  return n >= 1 ? Math.min(MAX, n) : 0;
};

const named = (name) => gradientOf(GRADIENTS.find((g) => g.name === name).stops);
// 默认库：常用的 10 个纯色；渐变偏彩虹、蓝紫、梦幻、星空这几个色系，排在前面。
export const DEFAULT_COLORS = [
  "#d9822b", "#3b82f6", "#16a34a", "#8b5cf6", "#e5484d",
  "#ec4899", "#8a8f98", "#c99a06", "#fbe9a6", "#d3e6fd",
  ...["彩虹", "霓虹", "柔光彩虹", "极光彩虹", "蓝紫", "靛紫", "蓝莓", "晴空紫", "葡萄",
    "梦境", "樱花", "薰衣草", "棉花糖", "天青", "星空", "银河", "星云", "深海",
    "晴空", "极光", "薄荷", "日落", "粉红", "蜜桃"].map(named),
];
// 材质色：金属、珠光、幻彩、晶石，用多个带位置的节点模拟反光
const MATERIALS = [
  ["银色", "#8e9eab 0%, #eef2f3 30%, #9ba7b0 50%, #f5f7f8 72%, #7f8c96 100%"],
  ["金色", "#a8741a 0%, #f6dc8a 30%, #c08a2a 50%, #fff0b3 72%, #9a6b16 100%"],
  ["紫金", "#4b1d6e 0%, #8a4fc0 28%, #d9b64a 50%, #fff0b3 62%, #6a2c91 100%"],
  ["玫瑰金", "#b76e79 0%, #f6cfcf 30%, #c4878d 50%, #fde4e1 72%, #a65e6a 100%"],
  ["香槟金", "#c9b18a 0%, #f7ecd6 30%, #d2bc94 50%, #fffaf0 72%, #b89f76 100%"],
  ["铂金", "#9aa3ad 0%, #e9edf1 30%, #b4bcc4 50%, #fbfcfd 72%, #8d969f 100%"],
  ["钛灰", "#4b5560 0%, #9aa5b1 30%, #5d6873 50%, #b7c1cb 72%, #424b55 100%"],
  ["黑金", "#1a1a1a 0%, #3a3226 30%, #c9a227 50%, #3a3226 70%, #111111 100%"],
  ["古铜", "#8c4a24 0%, #e8a87c 30%, #a8603a 50%, #f5c7a2 72%, #7a3e1e 100%"],
  ["珍珠白", "#f3efe8 0%, #fdfbf7 30%, #e8e2f0 50%, #fbf6ee 72%, #e6dfd6 100%"],
  ["珠光粉", "#f3c6d3 0%, #fff0f5 30%, #e9bfd6 50%, #fde8ef 72%, #e0aec1 100%"],
  ["珠光紫", "#c9b6e4 0%, #f3ecff 30%, #b9a3dc 50%, #efe6ff 72%, #a991cf 100%"],
  ["镭射", "#ff9a9e 0%, #fad0c4 20%, #a1c4fd 40%, #c2e9fb 60%, #d4fc79 80%, #fbc2eb 100%"],
  ["欧泊", "#a8edea 0%, #fed6e3 30%, #d4c4fb 55%, #c2f0e0 78%, #fbe3c4 100%"],
  ["极光膜", "#00c9ff 0%, #92fe9d 30%, #f9f586 50%, #fd8bd9 72%, #a18cd1 100%"],
  ["冰晶", "#e0f7ff 0%, #ffffff 30%, #b3e5fc 50%, #f0fbff 72%, #9fd8f5 100%"],
  ["紫水晶", "#3c1053 0%, #9d50bb 30%, #6e48aa 50%, #c39be6 72%, #3c1053 100%"],
  ["翡翠", "#0b5e3b 0%, #4fd1a1 30%, #138a5a 50%, #8ee8c4 72%, #0a4d31 100%"],
].map(([name, stops]) => [name, tidyAccent(`linear-gradient(135deg, ${stops})`)]);
export const DEFAULT_MATERIALS = MATERIALS.map(([, value]) => value);
const materialNamed = (name) => MATERIALS.find(([n]) => n === name)[1];
const DEFAULT_QUICK = [
  ...DEFAULT_COLORS.slice(0, QUICK),
  ...["彩虹", "蓝紫", "梦境", "星空"].map(named),
  ...["银色", "金色", "紫金", "镭射"].map(materialNamed),
];
// 内置颜色的版本：1 = 0.3.11 的默认渐变。旧颜色库只补一次，之后删掉的不会再回来。
const COLOR_REV = 1;
const NAMES = new Map([...GRADIENTS.map((g) => [gradientOf(g.stops), g.name]), ...MATERIALS.map(([n, v]) => [v, n])]);
export const gradientName = (color) => NAMES.get(color) || "";

// 纯色和渐变（不含材质）
export const sharedColorPresets = () => state.settings?.color_library ??
  [...new Set([...DEFAULT_COLORS, ...(state.settings?.color_presets ?? state.settings?.book_color_presets ?? [])])];
export const materialPresets = () => state.settings?.material_library ?? DEFAULT_MATERIALS;
const allColors = () => [...sharedColorPresets(), ...materialPresets()];
const typeOf = (color) => parseAccent(color)?.to ? "gradient" : "solid";
// 颜色属于哪一类：在材质色库里就是材质，否则看它是纯色还是渐变
export const kindOf = (color, materials = materialPresets()) => materials.includes(color) ? "material" : typeOf(color);
// 所有快捷色（保存的顺序）。旧设置没有 quick_colors 时：没改过颜色库就用默认快捷色，
// 改过就沿用颜色库的前 quick_color_count 个，材质用默认的几个。
const savedQuick = () => {
  const all = allColors();
  const saved = state.settings?.quick_colors;
  if (Array.isArray(saved)) return saved.filter((color) => all.includes(color));
  if (!Array.isArray(state.settings?.color_library)) return DEFAULT_QUICK.filter((color) => all.includes(color));
  const legacy = sharedColorPresets().slice(0, Math.max(1, Math.round(Number(state.settings?.quick_color_count) || QUICK)));
  return [...legacy, ...DEFAULT_QUICK.filter((color) => kindOf(color) === "material" && all.includes(color))];
};
const LIMIT_KEY = { solid: "quick_color_limit", gradient: "quick_gradient_limit", material: "quick_material_limit" };
const savedLimit = (kind, settings = state.settings) => quickLimit(settings?.[LIMIT_KEY[kind]]);
// 某一类的快捷色，不占颜色库里的位置：移出快捷栏就回到原来的地方。limit 为 0 表示不限。
export const quickColors = (kind, limit = savedLimit(kind)) => {
  const materials = materialPresets();
  const list = savedQuick().filter((color) => kindOf(color, materials) === kind);
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
// 电脑版存进设置文件；Android 没有 save_settings，由 mobile.js 换成存在手机上。
let saveColorSettings = async (next) => {
  const { saveSettings } = await import("./settings.js");
  await saveSettings(next);
};
export const setColorLibrarySaver = (save) => { saveColorSettings = save; };
// change(所有颜色, 这一类的快捷色, 材质集合) 返回：
//   library  新的所有颜色（纯色、渐变、材质混在一起，按 materials 分开保存）
//   materials 新的材质集合（不给就沿用）
//   quick    kind 这一类的新快捷色，或 allQuick 所有快捷色
// null 表示不用保存。limit 是这次操作时看到的快捷色上限（设置页里可能是还没保存的预览值）。
function updateLibrary(change, kind = "solid", limit = 0) {
  // 每次从最新已保存的颜色库计算，快速连续操作不会丢失修改。
  const task = presetQueue.then(async () => {
    const oldMaterials = new Set(materialPresets());
    const next = change(allColors(), quickColors(kind, limit), oldMaterials);
    if (next === null) return;
    const all = [...new Set(next.library ?? allColors())];
    const materials = next.materials ?? oldMaterials;
    const base = savedQuick();
    const raw = next.allQuick ?? (next.quick
      ? [...base.filter((color) => kindOf(color, [...oldMaterials]) !== kind), ...next.quick] : base);
    // 快捷色按 纯色、渐变、材质 分组存
    const quick = KINDS.flatMap((k) => raw.filter((color) => kindOf(color, [...materials]) === k));
    await saveColorSettings({
      ...state.settings,
      color_library: all.filter((color) => !materials.has(color)),
      material_library: all.filter((color) => materials.has(color)),
      quick_colors: [...new Set(quick)].filter((color) => all.includes(color)),
      color_library_rev: COLOR_REV,
    });
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
const withMaterial = (materials, color, on) => {
  const next = new Set(materials);
  if (on) next.add(color); else next.delete(color);
  return next;
};
// 存进颜色库：kind 为 material 时进材质色库，否则按颜色本身进纯色或渐变库。
export function changeSharedPreset(value, remove = false, kind = null) {
  const normalized = tidyAccent(value);
  if (!normalized) return Promise.reject(new Error("颜色格式无效"));
  return updateLibrary((all, quick, materials) => {
    if (remove) return { library: all.filter((c) => c !== normalized), materials: withMaterial(materials, normalized, false) };
    if (all.includes(normalized)) return null;
    const target = kind === "material" ? "material" : typeOf(normalized);
    if (all.filter((c) => kindOf(c, [...materials]) === target).length >= MAX) {
      throw new Error(KIND_LIBRARY[target] + "库最多保存 128 个颜色");
    }
    return { library: [...all, normalized], materials: withMaterial(materials, normalized, target === "material") };
  });
}
export function replaceSharedPreset(oldValue, newValue) {
  const normalized = tidyAccent(newValue);
  if (!normalized) return Promise.reject(new Error("颜色格式无效"));
  return updateLibrary((all, quick, materials) => {
    const index = all.indexOf(oldValue);
    if (index < 0) throw new Error("待编辑的颜色已被删除");
    const next = all.filter((color) => color !== oldValue && color !== normalized);
    next.splice(Math.min(index, next.length), 0, normalized);
    // 材质色改完还是材质色；快捷栏里的也换成新颜色，位置不变
    const material = materials.has(oldValue);
    return {
      library: next,
      materials: withMaterial(withMaterial(materials, oldValue, false), normalized, material),
      allQuick: savedQuick().map((color) => color === oldValue ? normalized : color),
    };
  });
}
// 恢复默认：只换 kinds 这几类的颜色和快捷色，别的类不动。
export const resetSharedPresets = (kinds = KINDS) => updateLibrary((all, quick, materials) => {
  const list = [...materials];
  const keep = (color) => !kinds.includes(kindOf(color, list));
  const defaults = [...DEFAULT_COLORS.filter((color) => kinds.includes(typeOf(color))),
    ...(kinds.includes("material") ? DEFAULT_MATERIALS : [])];
  const kept = all.filter(keep);
  return {
    library: [...kept, ...defaults.filter((color) => !kept.includes(color))],
    materials: new Set(kinds.includes("material") ? DEFAULT_MATERIALS : list.filter(keep)),
    allQuick: [...savedQuick().filter(keep), ...DEFAULT_QUICK.filter((color) =>
      kinds.includes(DEFAULT_MATERIALS.includes(color) ? "material" : typeOf(color)))],
  };
});
// 颜色库里的按钮和设置→外观里的按钮共用；返回是否真的恢复了。
export const askResetColors = (kinds = KINDS) => {
  const one = kinds.length === 1 ? KIND_LIBRARY[kinds[0]] : "";
  const what = one ? "默认" + one : "默认颜色库";
  return ask(`确定恢复${what}？自己添加或编辑的${one || "颜色"}会从颜色库中移除，快捷色也恢复默认；已经使用的颜色不会改变。`, "恢复默认", true, true)
    .then((confirmed) => confirmed && resetSharedPresets(kinds).then(() => { toast("已恢复" + what); return true; }));
};
export const restoreSharedPreset = (color, index, kind = null) => updateLibrary((all, quick, materials) => {
  if (all.includes(color)) return null;
  const next = [...all];
  next.splice(Math.min(Math.max(index, 0), all.length), 0, color);
  return { library: next, materials: withMaterial(materials, color, kind === "material") };
});
export const restoreQuickColor = (color, index) => updateLibrary((all, quick) => {
  if (!all.includes(color) || quick.includes(color)) return null;
  const next = [...quick];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, color);
  return { quick: next };
}, kindOf(color));
// 启动时给旧颜色库补上库里还没有的默认渐变（只补一次）；渐变快捷栏是空的就放上默认的几个。
export async function upgradeColorLibrary() {
  const s = state.settings;
  if (!s || !Array.isArray(s.color_library) || (Number(s.color_library_rev) || 0) >= COLOR_REV) return;
  await updateLibrary((all, quick, materials) => {
    const list = [...materials];
    const missing = DEFAULT_COLORS.filter((color) => typeOf(color) === "gradient" && !all.includes(color));
    const room = MAX - all.filter((color) => kindOf(color, list) === "gradient").length;
    const next = [...all, ...missing.slice(0, Math.max(0, room))];
    const saved = savedQuick();
    const gradientQuick = saved.some((color) => kindOf(color, list) === "gradient") ? [] :
      DEFAULT_QUICK.filter((color) => kindOf(color, list) === "gradient" && next.includes(color));
    return { library: next, allQuick: [...saved, ...gradientQuick] };
  });
}
// 记住每个入口上次看的是哪一类（只是界面习惯，存在本机浏览器存储里，读不到就算了）
const tabMemory = new Map();
const rememberedTab = (id) => {
  if (tabMemory.has(id)) return tabMemory.get(id);
  try { return localStorage.getItem("minipad.color-tab." + id); } catch { return null; }
};
const rememberTab = (id, kind) => {
  tabMemory.set(id, kind);
  try { localStorage.setItem("minipad.color-tab." + id, kind); } catch { /* 存不了就只在这次运行里记住 */ }
};
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
/** 返回可挂到任意容器的通用“颜色库 + 多节点编辑器”。
 *  id 用来记住这个入口上次看的是纯色还是渐变；getPreview 返回设置页里还没保存的颜色库选项。
 */
export function makeSharedColorTools({ id = "", getValue, onApply, defaultColor = "#d9822b", allowGradient = true, showPresets = true, compact = false, previewMode = "color", getPreview } = {}) {
  const root = make("section", compact ? "shared-colors compact" : "shared-colors");
  const head = make("div", "uc-head");
  const heading = make("div", "uc-title", "颜色库");
  // 顶部的「纯色 | 渐变」切换
  const switcher = make("div", "uc-kinds");
  switcher.setAttribute("role", "group");
  switcher.setAttribute("aria-label", "颜色类型");
  const kindButtons = KINDS.map((kind) => {
    const button = make("button", "uc-kind", KIND_NAME[kind]);
    button.type = "button";
    button.dataset.kind = kind;
    button.addEventListener("click", () => {
      if (tab === kind) return;
      tab = kind;
      if (id) rememberTab(id, kind);
      lastDeleted = null;
      undo.hidden = true;
      refreshPresets();
    });
    return button;
  });
  switcher.append(...kindButtons);
  head.append(heading, switcher);
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
  }
  const undo = make("button", "small uc-undo", "撤销删除");
  undo.type = "button";
  undo.hidden = true;
  actions.append(edit, save, undo, reset);
  let lastDeleted = null;
  let editingPreset = null;
  const prefs = () => ({ ...state.settings, ...(getPreview?.() || {}) });
  const rows = () => allowGradient && prefs().color_layout === "rows";
  // 打开时显示哪一类：记住上次的 / 总是纯色 / 总是渐变 / 跟随当前颜色
  const pickTab = () => {
    if (!allowGradient) return "solid";
    const mode = prefs().color_open_tab;
    if (KINDS.includes(mode)) return mode;
    const remembered = mode === "follow" || !id ? null : rememberedTab(id);
    return KINDS.includes(remembered) ? remembered : kindOf(current());
  };
  let tab = "solid";
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
  root.append(head, buttons, actions, editor);
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
    head.hidden = true;
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
    const p = prefs();
    const presets = allColors();
    const materials = materialPresets();
    const kindIn = (color) => kindOf(color, materials);
    const expanded = buttons.classList.contains("expanded");
    const both = rows();
    const kinds = !allowGradient ? ["solid"] : both ? KINDS : [tab];
    if (!kinds.includes(tab) && !both) tab = kinds[0];
    switcher.hidden = both || !allowGradient;
    for (const button of kindButtons) button.setAttribute("aria-pressed", String(button.dataset.kind === tab));
    const shape = ["bar", "round"].includes(p.gradient_shape) ? p.gradient_shape : "square";
    root.dataset.gradientShape = shape;
    reset.textContent = kinds.length > 1 ? "恢复默认颜色库" : "恢复默认" + KIND_NAME[kinds[0]];
    reset.title = (kinds.length > 1 ? "恢复内置颜色和快捷色" : "恢复内置的" + KIND_LIBRARY[kinds[0]] + "和它的快捷色") + "，已应用的颜色不受影响";
    reset.setAttribute("aria-label", reset.textContent);
    if (compact) reset.textContent = "恢复默认";
    // 每一类的快捷色单独保存，在颜色库里的位置不变；库里不重复显示快捷色。
    // 个数随拖进、移出增减，不超过设置里的上限（设置页打开时按正在填的上限预览）。
    const limits = Object.fromEntries(KINDS.map((kind) => [kind, savedLimit(kind, p)]));
    const quickOf = Object.fromEntries(kinds.map((kind) => [kind, quickColors(kind, limits[kind])]));
    const span = (color) => typeOf(color) === "gradient" && shape === "bar" ? 2 : 1;
    // 收起时 ＋ 放在第一行快捷色后面
    const first = quickOf[kinds[0]];
    let cells = 0;
    for (const color of first) { if (cells + span(color) > 5) break; cells += span(color); }
    buttons.style.setProperty("--uc-toggle-column", String(first.length ? cells + 1 : 6));
    // 展开后每个快捷栏末尾多一个「＋」空位
    const quickCells = kinds.reduce((sum, kind) =>
      sum + Math.max(1, quickOf[kind].reduce((n, c) => n + span(c), 0) + (expanded ? 1 : 0)), 0);
    buttons.style.setProperty("--uc-quick-rows", String(Math.max(1, Math.ceil(quickCells / 6))));
    const sections = kinds.flatMap((kind) => {
      const quick = { role: "quick", kind, colors: quickOf[kind],
        title: both ? KIND_NAME[kind] + "快捷（收起时显示）" : "快捷（收起时显示）" };
      if (!expanded) return [quick];
      return [quick, { role: "library", kind, title: KIND_LIBRARY[kind],
        colors: presets.filter((color) => kindIn(color) === kind && !quickOf[kind].includes(color)) }];
    });
    let draggingColor = null;
    const inQuick = (value) => quickColors(kindOf(value), limits[kindOf(value)]).includes(value);
    // 只能在同一类里拖：纯色进纯色快捷栏和纯色库，渐变同理。
    const canDrop = (value, section, targetColor = null) =>
      !!value && presets.includes(value) && value !== targetColor && kindIn(value) === section.kind;
    const dropAt = (value, section, targetColor = null) => {
      if (!canDrop(value, section, targetColor)) return;
      const limit = limits[section.kind];
      void updateLibrary((library, quick) => {
        if (section.role === "quick") {
          // 拖进快捷区多一个；到上限时挤掉最后一个（不是刚拖进来的这个），它回到原来的位置。
          const next = quick.includes(value) ? moved(quick, value, targetColor) : before(quick, value, targetColor);
          while (limit && next.length > limit) next.splice(next.at(-1) === value ? -2 : -1, 1);
          return { quick: next };
        }
        const rest = quick.filter((color) => color !== value);
        // 拖到分类标题：快捷色回到原来的位置；库里的颜色排到这一类最前面。
        const lead = library.find((color) => color !== value && !rest.includes(color) && kindOf(color) === section.kind);
        const next = targetColor ? moved(library, value, targetColor) :
          quick.includes(value) || !lead ? library : before(library, value, lead);
        return { library: next, quick: rest };
      }, section.kind, limit).catch((err) => toast(String(err)));
    };
    const ofKind = (kind) => presets.some((color) => kindIn(color) === kind);
    if (!presets.length) buttons.append(make("span", "muted", "还没有保存的颜色"));
    else if (!expanded && kinds.every((kind) => !quickOf[kind].length)) {
      buttons.append(make("span", "muted", kinds.some(ofKind) ? "点 ＋ 把颜色拖进快捷栏" : "还没有保存的" + KIND_LIBRARY[kinds[0]]));
    }
    sections.forEach((section, index) => {
      // 两行同时显示时，收起状态下渐变快捷栏另起一行
      if (index && !expanded) buttons.append(make("div", "uc-break"));
      if (expanded) {
        const label = make("div", "uc-kind-title" + (index === 0 ? " first" : ""), section.title);
        label.dataset.section = section.role === "quick" ? "quick" : section.kind;
        label.dataset.kind = section.kind;
        label.setAttribute("role", "heading");
        label.setAttribute("aria-level", "3");
        label.title = section.role === "quick" ? "将" + KIND_NAME[section.kind] + "拖到此处设为快捷色" : "将快捷色拖到此处移出快捷栏";
        label.addEventListener("dragover", (e) => {
          if (!canDrop(draggingColor, section)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });
        label.addEventListener("drop", (e) => {
          if (!canDrop(draggingColor, section)) return;
          e.preventDefault();
          dropAt(draggingColor, section);
        });
        buttons.append(label);
        if (presets.length && !section.colors.length && section.role === "library") {
          buttons.append(make("span", "muted uc-empty", "还没有保存的" + KIND_LIBRARY[section.kind]));
        }
      }
      for (const color of section.colors) {
        const parsed = parseAccent(color);
        if (!parsed) continue;
        const wrap = make("div", "uc-preset" + (span(color) > 1 ? " bar" : ""));
        wrap.draggable = true;
        wrap.dataset.color = color;
        wrap.title = "拖动排序；焦点在色块上时可按 Shift+左右箭头排序";
        const swatch = make("button", "uc-swatch" + (parsed.to ? " gradient" : ""));
        swatch.dataset.color = color;
        swatch.type = "button";
        swatch.classList.toggle("on", color === current());
        const name = parsed.to && p.gradient_names !== false ? gradientName(color) : "";
        swatch.title = "使用 " + (name ? KIND_NAME[kindIn(color)] + "「" + name + "」" : color);
        swatch.setAttribute("aria-label", "使用保存的颜色 " + (name ? name + " " : "") + color);
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
          const limit = limits[section.kind];
          const ordered = section.role === "quick" ? quickColors(section.kind, limit) :
            allColors().filter((entry) => kindOf(entry) === section.kind && !inQuick(entry));
          const next = ordered[ordered.indexOf(color) + (e.key === "ArrowLeft" ? -1 : 1)];
          if (!next) return;
          void updateLibrary((library, quick) => section.role === "quick"
            ? { quick: moved(quick, color, next) } : { library: moved(library, color, next) }, section.kind, limit)
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
          if (!buttons.classList.contains("expanded") || !canDrop(draggingColor, section, color)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });
        wrap.addEventListener("drop", (e) => {
          if (!buttons.classList.contains("expanded") || !canDrop(draggingColor, section, color)) return;
          e.preventDefault();
          dropAt(draggingColor, section, color);
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
        // 快捷栏里的 × 只是移出快捷栏，颜色回到原来的位置；库里的 × 才从颜色库删除。
        const fromQuick = section.role === "quick";
        if (fromQuick) {
          remove.title = "移出快捷栏（回到原来的位置）";
          remove.setAttribute("aria-label", "移出快捷栏 " + color);
        }
        remove.addEventListener("click", () => {
          const index = (fromQuick ? quickColors(section.kind, 0) : allColors()).indexOf(color);
          const operation = fromQuick
            ? updateLibrary((library, quick) => ({ quick: quick.filter((entry) => entry !== color) }), section.kind, limits[section.kind])
            : changeSharedPreset(color, true);
          void operation.then(() => {
            lastDeleted = { color, index, quick: fromQuick, kind: section.kind };
            undo.textContent = fromQuick ? "撤销移出" : "撤销删除";
            undo.hidden = false;
            toast(fromQuick ? "已移出快捷栏，可点击“撤销移出”" : "已删除颜色，可点击“撤销删除”");
          }).catch((err) => toast(String(err)));
        });
        wrap.append(swatch, remove);
        buttons.append(wrap);
      }
      // 快捷栏末尾的「＋」空位：拖到这里加到最后，不用瞄准标题
      if (expanded && section.role === "quick") {
        const slot = make("div", "uc-drop-slot", "＋");
        slot.dataset.kind = section.kind;
        slot.title = "把" + KIND_NAME[section.kind] + "拖到这里，加到快捷栏最后";
        slot.addEventListener("dragover", (e) => {
          if (!canDrop(draggingColor, section)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          slot.classList.add("over");
        });
        slot.addEventListener("dragleave", () => slot.classList.remove("over"));
        slot.addEventListener("drop", (e) => {
          slot.classList.remove("over");
          if (!canDrop(draggingColor, section)) return;
          e.preventDefault();
          dropAt(draggingColor, section);
        });
        buttons.append(slot);
      }
    });
    buttons.append(more);
    more.hidden = !showPresets;
    if (focusMore) more.focus();
    else if (focusColor) [...buttons.querySelectorAll(".uc-swatch")]
      .find((swatch) => swatch.dataset.color === focusColor)?.focus();
  };
  undo.addEventListener("click", () => {
    if (!lastDeleted) return;
    const { color, index, quick, kind } = lastDeleted;
    void (quick ? restoreQuickColor(color, index) : restoreSharedPreset(color, index, kind)).then(() => {
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
    // 在材质页保存的进材质色库，其余按颜色本身进纯色或渐变库
    const operation = editingPreset
      ? replaceSharedPreset(editingPreset, value())
      : changeSharedPreset(editor.hidden ? current() : value(), false, !rows() && tab === "material" ? "material" : null);
    const added = editingPreset ? null : tidyAccent(editor.hidden ? current() : value());
    void operation.then(() => {
      editor.hidden = true; editingPreset = null; edit.setAttribute("aria-expanded", "false");
      // 新存的颜色进它那一类的库，并切到那一类
      if (!rows() && allowGradient && added) tab = kindOf(added);
      toast("颜色库已保存");
      refreshPresets();
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
  reset.addEventListener("click", () => void askResetColors(!allowGradient ? ["solid"] : rows() ? KINDS : [tab]).then((done) => {
    if (done) { editor.hidden = true; editingPreset = null; edit.setAttribute("aria-expanded", "false"); }
  }).catch((e) => toast(String(e))));
  // reopen：入口重新打开时按“打开时显示”选哪一类
  const reopen = () => { tab = pickTab(); refreshPresets(); };
  const tool = { root, refreshPresets, reopen, sync: () => { if (!editor.hidden && !editingPreset) startEditing(); refreshPresets(); } };
  for (const stale of live) if (!stale.root.isConnected) live.delete(stale);
  live.add(tool);
  reopen();
  return tool;
}
