// 打包 Milkdown 用的入口:scripts/prepare.mjs 用 esbuild 把这里导出的东西打成一个文件 src/vendor/milkdown.js,
// 前端的 src/js/editor.js 等文件从那个文件里导入。Milkdown 是基于 ProseMirror 的所见即所得 Markdown 编辑器。
export * from "@milkdown/kit/core";
export * from "@milkdown/kit/preset/commonmark";
export * from "@milkdown/kit/preset/gfm";
export { history } from "@milkdown/kit/plugin/history";
export { clipboard } from "@milkdown/kit/plugin/clipboard";
export { trailing } from "@milkdown/kit/plugin/trailing";
export { $prose, $view, $shortcut, callCommand, getMarkdown } from "@milkdown/kit/utils";
export { Plugin, PluginKey, TextSelection, NodeSelection, EditorState, Selection } from "@milkdown/kit/prose/state";
export { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
export { Fragment, Slice } from "@milkdown/kit/prose/model";
export { undo, redo, closeHistory } from "@milkdown/kit/prose/history";
export { toggleMark, setBlockType, wrapIn, lift } from "@milkdown/kit/prose/commands";
export { wrapInList, sinkListItem, liftListItem, splitListItem } from "@milkdown/kit/prose/schema-list";
