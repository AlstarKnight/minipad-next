// 常用的页面元素
export const $ = (sel) => document.querySelector(sel);
// 编辑区的容器,CodeMirror 编辑器在它里面(见 editor.js)
export const editorEl = $("#editor");
export const preview = $("#preview");
export const tabsEl = $("#tabs");
