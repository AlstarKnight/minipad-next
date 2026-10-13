import { parseAccent } from "./accent.js";
// 笔记本图标：固定的 SVG 图形，不插入文件里的任意 HTML。
export const BOOK_ICONS = [
  ["book", "书本"],
  ["folder", "文件夹"],
  ["briefcase", "工作"],
  ["heart", "爱心"],
  ["star", "星星"],
  ["lightbulb", "灵感"],
  ["code", "代码"],
  ["bookmark", "书签"],
];
const SHAPES = {
  book: '<path d="M2.5 3.2c2-.8 3.8-.7 5.5.3 1.7-1 3.5-1.1 5.5-.3v9c-2-.8-3.8-.7-5.5.3-1.7-1-3.5-1.1-5.5-.3z"/><path d="M8 3.5v9"/>',
  folder: '<path d="M1.5 4.5a1 1 0 0 1 1-1H6l1.5 1.6h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
  briefcase: '<rect x="1.6" y="4.7" width="12.8" height="9" rx="1.5"/><path d="M5.5 4.7V3.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M1.6 8.8c3.2 1.8 9.6 1.8 12.8 0M7 9h2"/>',
  heart: '<path d="M8 13.7 2.6 8.4C-1.2 4.6 4.4.8 8 4.6c3.6-3.8 9.2 0 5.4 3.8z"/>',
  star: '<path d="m8 1.5 2.1 4.3 4.7.7-3.4 3.3.8 4.7L8 12.3l-4.2 2.2.8-4.7L1.2 6.5l4.7-.7z"/>',
  lightbulb: '<path d="M5.3 11.4c0-2.1-2.1-2.8-2.1-5.3a4.8 4.8 0 0 1 9.6 0c0 2.5-2.1 3.2-2.1 5.3zM5.4 13h5.2M6.2 14.7h3.6"/>',
  code: '<path d="m5.3 4.3-3.6 3.7 3.6 3.7M10.7 4.3l3.6 3.7-3.6 3.7M9.1 2.7 6.9 13.3"/>',
  bookmark: '<path d="M4 2.1h8v12l-4-3-4 3z"/>',
};
let nextGradientId = 0;

// SVG strokes can use a real gradient paint server. Every icon gets its own ID,
// so separate notebooks never accidentally share another icon's gradient.
export function bookIcon(icon, color = "") {
  const shape = SHAPES[icon] || SHAPES.book;
  const parsed = parseAccent(color);
  if (!parsed?.to) return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${shape}</svg>`;
  const id = `book-icon-gradient-${++nextGradientId}`;
  const angle = (parsed.deg * Math.PI) / 180;
  const dx = Math.sin(angle) * 8;
  const dy = -Math.cos(angle) * 8;
  const stops = parsed.stops.map((hex, i) =>
    `<stop offset="${parsed.positions?.[i] ?? (i / (parsed.stops.length - 1)) * 100}%" stop-color="${hex}"/>`
  ).join("");
  const defs = `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${8 - dx}" y1="${8 - dy}" x2="${8 + dx}" y2="${8 + dy}">${stops}</linearGradient></defs>`;
  return `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" style="stroke: url(#${id})">${defs}${shape}</svg>`;
}
export function iconColor(book) {
  return parseAccent(book?.icon_color)?.from || "var(--accent)";
}
