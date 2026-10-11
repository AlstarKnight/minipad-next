// 打包 CodeMirror 6 用的入口:scripts/prepare.mjs 用 esbuild 把这里导出的东西打成一个文件 src/vendor/codemirror.js,
// 前端的 src/js/editor.js 从那个文件里导入。要用 CodeMirror 的新功能时在这里加导出。
export { Annotation, Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
export { Decoration, EditorView, ViewPlugin, drawSelection, keymap, lineNumbers, placeholder } from "@codemirror/view";
export { defaultKeymap, history, historyKeymap, indentLess, indentMore, isolateHistory, redo } from "@codemirror/commands";
export { HighlightStyle, indentUnit, syntaxHighlighting, syntaxTree } from "@codemirror/language";
export { markdown, markdownLanguage } from "@codemirror/lang-markdown";
export { tags } from "@lezer/highlight";
