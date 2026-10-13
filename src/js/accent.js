// ---------- 强调色和渐变色 ----------
// 强调色用在活跃标签上面那条线、亮起来的按钮、勾选框、主要按钮、链接等地方。
// 设置里存成一个字符串:空着是主题自带的橙色,"#3b82f6" 是纯色,"linear-gradient(135deg, #a, #b)" 是渐变色。
// 字体颜色的渐变色也用同样的写法(见 colors.js)

const HEX = /^#[0-9a-f]{6}$/i;
const STOP = /^(#[0-9a-f]{6})(?:\s+(\d{1,3})%)?$/i;
// 兼容旧颜色字符串；0.3.4 新增每个节点的可选位置。
export const gradientOf = (stops, deg = 135, positions = null) =>
  `linear-gradient(${deg}deg, ${stops.map((s, i) => positions?.[i] != null ? s + " " + positions[i] + "%" : s).join(", ")})`;
export const gradient = (from, to, deg = 135) => gradientOf([from, to], deg);

// 几种渐变色:强调色和字体颜色共用。蓝色、紫色系的多一些
export const GRADIENTS = [
  { name: "晴空", stops: ["#4facfe", "#00c6fb"] },
  { name: "蓝紫", stops: ["#5fb4ff", "#d66cf0"] },
  { name: "星空", stops: ["#2575fc", "#6a11cb"] },
  { name: "靛紫", stops: ["#667eea", "#764ba2"] },
  { name: "紫罗兰", stops: ["#8e2de2", "#c471f5"] },
  { name: "薰衣草", stops: ["#a18cd1", "#e37bd4"] },
  { name: "霓虹", stops: ["#29d9f5", "#e83cf4"] },
  { name: "极光", stops: ["#38d6c4", "#4a7cf0"] },
  { name: "青蓝", stops: ["#38d6c4", "#7f8ff5"] },
  { name: "粉红", stops: ["#f857a6", "#ff5858"] },
  { name: "橙黄", stops: ["#ff8a4c", "#f7c34b"] },
  { name: "彩虹", stops: ["#ff5f6d", "#ffa94d", "#f5d142", "#51cf66", "#4dabf7", "#9775fa"] },
];

export const ACCENTS = [
  { name: "默认(橙色)", value: "" },
  { name: "蓝色", value: "#3b82f6" },
  { name: "绿色", value: "#16a34a" },
  { name: "紫色", value: "#8b5cf6" },
  { name: "粉色", value: "#ec4899" },
  { name: "红色", value: "#e5484d" },
  ...GRADIENTS.map((g) => ({ name: g.name + "渐变", value: gradientOf(g.stops) })),
];

// 拆开一个颜色值:{ from, to, stops, deg }(纯色时 to 为空);不认识就返回 null
export function parseAccent(value) {
  value = (value || "").trim();
  if (HEX.test(value)) return { from: value.toLowerCase(), to: "", stops: [value.toLowerCase()], positions: null };
  if (!value.startsWith("linear-gradient(") || !value.endsWith(")")) return null;
  const body = value.slice(16, -1);
  const parts = body.split(",").map((v) => v.trim());
  const angle = /^(\d{1,3})deg$/.exec(parts.shift() || "");
  if (!angle || Number(angle[1]) > 360 || parts.length < 2 || parts.length > 7) return null;
  const matched = parts.map((s) => STOP.exec(s));
  if (matched.some((m) => !m)) return null;
  const stops = matched.map((m) => m[1].toLowerCase());
  const values = matched.map((m) => m[2] === undefined ? null : Number(m[2]));
  if (values.some((v) => v != null && v > 100)) return null;
  if (values.some((v) => v != null) && values.some((v) => v == null)) return null;
  if (values.some((v, i) => i > 0 && v < values[i - 1])) return null;
  const positions = values[0] == null ? null : values;
  return { from: stops[0], to: stops.at(-1), stops, deg: Number(angle[1]), positions };
}

// 整理成统一的写法;不认识就是空(用默认)
export function tidyAccent(value) {
  const a = parseAccent(value);
  if (!a) return "";
  return a.to ? gradientOf(a.stops, a.deg, a.positions) : a.from;
}

// 把强调色放到页面上:--accent 是纯色(渐变取起点的颜色),--accent-grad 可以是渐变,--accent-soft 是淡的底色
export function applyAccent(value) {
  const root = document.documentElement.style;
  const a = parseAccent(value);
  if (!a) {
    for (const v of ["--accent", "--accent-grad", "--accent-soft", "--accent-end"]) root.removeProperty(v);
    document.documentElement.classList.remove("accent-gradient");
    return;
  }
  root.setProperty("--accent", a.from);
  root.setProperty("--accent-end", a.to || a.from);
  root.setProperty("--accent-grad", a.to ? gradientOf(a.stops, a.deg, a.positions) : a.from);
  root.setProperty("--accent-soft", `color-mix(in srgb, ${a.from} 16%, transparent)`);
  document.documentElement.classList.toggle("accent-gradient", !!a.to);
  if (a.to) svgGradient(a.stops, a.positions);
}

// 亮起来的图标(比如置顶)是线条画的,渐变色要放进一个 SVG 渐变里,图标的线条再引用它(见 style.css)
function svgGradient(stops, positions) {
  let defs = document.getElementById("accent-defs");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    defs.id = "accent-defs";
    defs.setAttribute("aria-hidden", "true");
    defs.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    document.body.append(defs);
  }
  const step = (i) => (stops.length > 1 ? (i / (stops.length - 1)) * 100 : 0);
  defs.innerHTML =
    `<linearGradient id="accent-svg-grad" gradientUnits="userSpaceOnUse" x1="1" y1="1" x2="15" y2="15">` +
    stops.map((c, i) => `<stop offset="${positions?.[i] ?? step(i)}%" stop-color="${c}"/>`).join("") +
    `</linearGradient>`;
}
