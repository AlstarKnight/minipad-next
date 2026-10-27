// ---------- 设置 → 快捷键(0.5.5):一张表列出全部快捷键,点一行的按键录新的组合键 ----------
// 改的是一份草稿,点设置的「保存」才写进设置(和别的设置一样,点「取消」就不算)
import { api } from "./api.js";
import { $ } from "./dom.js";
import { toast } from "./ui.js";
import {
  COMMANDS, GLOBAL_COMMANDS, EDITOR_KEYS, comboOf, usable, same, sameKeys, keysOf, defaultKeys, withKeys,
  holderOf, warningsOf, keyLabel, exportKeys, importKeys,
} from "./shortcuts.js";

// 正在改的:shortcuts 和三个旧的热键设置,还有决定查找默认键的 ctrl_f
let draft = {};
// 正在录的那一行:{ btn, c }
let recording = null;
// 提示(冲突、提醒)放在哪一行下面
let msgFor = null;
let answer = null;
let imported = null;
const msg = document.createElement("div");
msg.id = "set-keys-msg";
msg.setAttribute("role", "status");

export function showKeys(s) {
  draft = { shortcuts: { ...(s.shortcuts || {}) }, hotkey: s.hotkey, capture_hotkey: s.capture_hotkey || "", quick_switch_key: s.quick_switch_key || "", ctrl_f: s.ctrl_f };
  $("#set-keys-filter").value = "";
  closePreview();
  message("");
  render();
}

// 保存设置时拿走的
export const keysDraft = () => ({ shortcuts: draft.shortcuts, hotkey: draft.hotkey, capture_hotkey: draft.capture_hotkey, quick_switch_key: draft.quick_switch_key });

function chips(el, keys) {
  if (!keys.length) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = "不用";
    return el.replaceChildren(none);
  }
  el.replaceChildren(...keys.map((k) => {
    const kbd = document.createElement("kbd");
    kbd.textContent = keyLabel(k);
    return kbd;
  }));
}

function row(c, fixed) {
  const keys = fixed ? c.keys : keysOf(draft, c.id);
  const el = document.createElement("div");
  el.className = "key-row";
  const name = document.createElement("span");
  name.className = "key-name";
  name.textContent = c.name;
  const keyBox = document.createElement(fixed ? "span" : "button");
  keyBox.className = "key-keys";
  chips(keyBox, fixed && c.label ? [c.label] : keys);
  el.append(name, keyBox);
  el.dataset.search = [c.name, ...keys.flatMap((k) => [k, keyLabel(k)])].join(" ").toLowerCase();
  if (fixed) {
    if (c.label) keyBox.firstChild.textContent = c.label;
    return el;
  }
  el.dataset.cmd = c.id;
  keyBox.type = "button";
  keyBox.title = "点一下,再按下新的组合键";
  keyBox.setAttribute("aria-label", `${c.name}:${keys.map(keyLabel).join("、") || "不用"}。点一下录新的组合键`);
  keyBox.addEventListener("click", () => startRecording(keyBox, c));
  keyBox.addEventListener("blur", () => recording?.btn === keyBox && stopRecording());
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "key-reset";
  reset.textContent = "恢复默认";
  reset.hidden = sameKeys(keys, defaultKeys(draft, c.id));
  reset.addEventListener("click", () => void assign(c, defaultKeys(draft, c.id)));
  el.append(reset);
  return el;
}

function render() {
  const q = $("#set-keys-filter").value.trim().toLowerCase();
  const box = $("#set-keys");
  const groups = [["应用内", COMMANDS, false], ["全局热键(在别的程序里也能按)", GLOBAL_COMMANDS, false], ["编辑区(固定,不能改)", EDITOR_KEYS, true]];
  box.replaceChildren(...groups.flatMap(([title, list, fixed]) => {
    const rows = list.map((c) => row(c, fixed)).filter((r) => !q || r.dataset.search.includes(q));
    if (!rows.length) return [];
    const h = document.createElement("h3");
    h.textContent = title;
    return [h, ...rows];
  }));
  if (!box.childElementCount) {
    const none = document.createElement("div");
    none.className = "muted key-none";
    none.textContent = "没有找到";
    box.append(none);
  }
  placeMessage();
}

function placeMessage() {
  const at = msgFor && $(`#set-keys .key-row[data-cmd="${msgFor}"]`);
  if (at) at.after(msg);
  else $("#set-keys").prepend(msg);
}

// 表里的提示:kind 是 warn(提醒)或 error;buttons 有的话等用户点一个,返回点的那个的下标
function message(text, { kind = "", cmd = null, buttons = [] } = {}) {
  answer?.(-1);
  answer = null;
  msgFor = cmd;
  msg.hidden = !text;
  msg.className = kind;
  msg.replaceChildren(text);
  placeMessage();
  if (!buttons.length) return Promise.resolve(-1);
  return new Promise((resolve) => {
    answer = resolve;
    buttons.forEach((label, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", () => {
        answer = null;
        message("");
        resolve(i);
      });
      msg.append(b);
    });
  });
}

// 录新的组合键:先停用全局热键,不然按下现在的热键会把窗口藏起来
function startRecording(btn, c) {
  stopRecording();
  message("");
  recording = { btn, c };
  btn.classList.add("recording");
  btn.textContent = "按下新的组合键…(Esc 取消,Backspace 清空)";
  api.invoke("pause_hotkey").catch(() => {});
}

function stopRecording() {
  if (!recording) return;
  const { btn, c } = recording;
  recording = null;
  btn.classList.remove("recording");
  chips(btn, keysOf(draft, c.id));
  api.invoke("resume_hotkey").catch(() => {});
}

function onKey(e) {
  if (!recording || e.target !== recording.btn) return;
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
  // Tab 让焦点走开(失去焦点就不录了)
  if (plain && e.key === "Tab") return;
  e.preventDefault();
  e.stopPropagation();
  const { c } = recording;
  if (plain && e.key === "Escape") return stopRecording();
  if (plain && (e.key === "Backspace" || e.key === "Delete")) {
    stopRecording();
    if (c.required) return void message(`${c.name}的热键不能空着`, { kind: "error", cmd: c.id });
    return void assign(c, []);
  }
  const combo = comboOf(e);
  // 只按了修饰键:接着等
  if (!combo) return;
  if (!usable(combo)) return void message("要带上 Ctrl、Alt 或 Win 键(F1~F12 可以单独用)", { kind: "error", cmd: c.id });
  stopRecording();
  void assign(c, [combo]);
}

// 换上新的按键:别的命令在用的先问替换还是取消;全局热键先试一下能不能用
async function assign(c, keys) {
  for (const k of keys) {
    const other = holderOf(draft, k, c.id);
    if (!other) continue;
    if (other.required) return void message(`${keyLabel(k)} 是「${other.name}」的热键,它不能空着,先给它换一个`, { kind: "error", cmd: c.id });
    const pick = await message(`${keyLabel(k)} 已经是「${other.name}」的快捷键`, { kind: "warn", cmd: c.id, buttons: ["替换", "取消"] });
    if (pick !== 0) return;
    draft = withKeys(draft, other.id, keysOf(draft, other.id).filter((x) => !same(x, k)));
  }
  if (c.global) {
    for (const k of keys) {
      try {
        await api.invoke("probe_hotkey", { combo: k });
      } catch (err) {
        render();
        return void message(`${keyLabel(k)} 被系统或别的程序占用了,换一个吧(${err})`, { kind: "error", cmd: c.id });
      }
    }
  }
  draft = withKeys(draft, c.id, keys);
  render();
  const warnings = keys.flatMap(warningsOf);
  message(warnings.join(";"), { kind: "warn", cmd: c.id });
}

function closePreview() {
  imported = null;
  $("#set-keys-preview").hidden = true;
}

async function importFile() {
  let text;
  try {
    text = await api.invoke("import_shortcuts");
  } catch (e) {
    return toast("没能读这个文件:" + e, 5000);
  }
  if (text == null) return;
  const result = importKeys(draft, text);
  const box = $("#set-keys-preview");
  const list = $("#set-keys-changes");
  box.hidden = false;
  if (result.error) {
    imported = null;
    $("#set-keys-summary").textContent = result.error;
    list.replaceChildren();
    $("#set-keys-apply").disabled = true;
    return;
  }
  imported = result.next;
  const parts = [result.changes.length ? `导入后有 ${result.changes.length} 项会改变:` : "导入的和现在的一样,没有要改的"];
  if (result.skipped) parts.push(`(${result.skipped} 项认不出,跳过)`);
  if (result.duplicates.length) parts.push(`导入后这些按键重复了,先改好文件再导入:${result.duplicates.join(";")}`);
  $("#set-keys-summary").textContent = parts.join("");
  list.replaceChildren(...result.changes.map((x) => {
    const li = document.createElement("li");
    li.textContent = `${x.name}:${x.from.map(keyLabel).join("、") || "不用"} → ${x.to.map(keyLabel).join("、") || "不用"}`;
    return li;
  }));
  $("#set-keys-apply").disabled = !result.changes.length || result.duplicates.length > 0;
}

export function bindKeys() {
  $("#set-keys").addEventListener("keydown", onKey);
  $("#set-keys-filter").addEventListener("input", render);
  // 「Ctrl+F 是…」换了,查找和搜索的默认键跟着换
  $("#set-ctrl-f").addEventListener("change", () => {
    draft = { ...draft, ctrl_f: $("#set-ctrl-f").value };
    render();
  });
  $("#set-keys-reset").addEventListener("click", () => {
    draft = { ...draft, shortcuts: {}, hotkey: defaultKeys(draft, "hotkey")[0], capture_hotkey: defaultKeys(draft, "capture")[0], quick_switch_key: defaultKeys(draft, "quick_switch")[0] };
    render();
    message("全部换回了默认的按键,点「保存」生效");
  });
  $("#set-keys-export").addEventListener("click", async () => {
    try {
      if (await api.invoke("export_shortcuts", { text: exportKeys(draft) })) toast("快捷键已导出");
    } catch (e) {
      toast("没能导出:" + e, 5000);
    }
  });
  $("#set-keys-import").addEventListener("click", () => void importFile());
  $("#set-keys-apply").addEventListener("click", () => {
    if (!imported) return;
    draft = imported;
    closePreview();
    render();
    message("已导入,点「保存」生效");
  });
  $("#set-keys-cancel").addEventListener("click", closePreview);
}
