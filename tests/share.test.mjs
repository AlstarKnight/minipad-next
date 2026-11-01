// 分享到 Minipad(0.5.5):分享的内容怎么拆开、写成什么样、放在页面的哪里
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShared, shareLines, shareBlock, insertShare } from "../src/js/share.js";

const date = new Date(2026, 9, 27, 13, 5);
const STAMP = "13:05 2026/10/27";

test("a shared link is split from its text; the title comes with the share or is the one line before the link", () => {
  // 浏览器:文字只有网址,标题单独带来
  assert.deepEqual(parseShared({ text: "https://example.com/a", title: "Example" }), { body: "", title: "Example", url: "https://example.com/a" });
  // 网址前面只有一行字(中文冒号也去掉)
  assert.deepEqual(parseShared({ text: "文章标题：https://mp.weixin.qq.com/s/abc" }), { body: "", title: "文章标题", url: "https://mp.weixin.qq.com/s/abc" });
  // 前面有好几行:那是正文
  assert.deepEqual(parseShared({ text: "第一行\r\n第二行\nhttps://x.y/z" }), { body: "第一行\n第二行", title: "", url: "https://x.y/z" });
  // 正文和带来的标题一样时只留标题
  assert.deepEqual(parseShared({ text: "同一个 https://x.y", title: "同一个" }), { body: "", title: "同一个", url: "https://x.y" });
  // 网址在中间不拆
  assert.deepEqual(parseShared({ text: "看 https://x.y 这个" }), { body: "看 https://x.y 这个", title: "", url: "" });
});

test("a share becomes lines with the time, the text and the source; nothing shared writes nothing", () => {
  assert.deepEqual(shareLines({ text: "https://example.com/a", title: "Example" }, { date }), [`${STAMP} [Example](https://example.com/a)`]);
  assert.deepEqual(shareLines({ text: "第一行\n\n  第二行  \nhttps://x.y/z" }, { date }), [`${STAMP} 第一行`, "第二行", "https://x.y/z"]);
  // 只有标题没有链接:标题放在最后一行
  assert.deepEqual(shareLines({ text: "摘的一段", title: "某本书" }, { date, stamp: false }), ["摘的一段", "某本书"]);
  // 不带来源:原样记下分享的文字,带来的标题不要
  assert.deepEqual(shareLines({ text: "看看 https://x.y", title: "标题" }, { date, source: false, stamp: false }), ["看看 https://x.y"]);
  // 空的
  assert.deepEqual(shareLines({ text: " \n \n", title: "" }, { date }), []);
  assert.deepEqual(shareLines({ text: "", title: "  " }, { date }), []);
  assert.deepEqual(shareLines({}, { date }), []);
});

test("shared text is kept as plain text: Markdown marks are escaped, links stay as they are", () => {
  const out = shareLines({ text: "# 不是标题\n- 不是列表\n1. 不是编号\n---\n> 不是引用\nsnake_case _斜_ *粗* `码` [[页]] <b> ~~删~~ https://a.com/x_y_(z)" }, { date, stamp: false, source: false });
  assert.deepEqual(out, [
    "\\# 不是标题", "\\- 不是列表", "1\\. 不是编号", "\\---", "\\> 不是引用",
    "snake_case \\_斜\\_ \\*粗\\* \\`码\\` \\[\\[页\\]\\] \\<b> \\~\\~删\\~\\~ https://a.com/x_y_(z)",
  ]);
  // 链接的文字和地址里的括号
  assert.deepEqual(shareLines({ text: "https://a.com/(x)", title: "A [b] *c*" }, { date, stamp: false }), ["[A \\[b\\] \\*c\\*](https://a.com/%28x%29)"]);
});

test("each share is a paragraph, a list item or a to-do; more lines stay inside the item", () => {
  assert.equal(shareBlock(["a", "b"]), "a\nb");
  assert.equal(shareBlock(["a", "b"], "list"), "- a\n  b");
  assert.equal(shareBlock(["a"], "task"), "- [ ] a");
  assert.equal(shareBlock(["a", "b"], "task", "*"), "* [ ] a\n  b");
});

test("written at the end or the start (under a leading heading), joining a list right next to it", () => {
  const one = ["记一下"];
  // 末尾
  assert.equal(insertShare("第一段\n", one), "第一段\n\n记一下\n");
  assert.equal(insertShare("", one, { format: "list" }), "- 记一下\n");
  assert.equal(insertShare("第一段\n\n* a\n* b\n\n\n", ["x", "y"], { format: "list" }), "第一段\n\n* a\n* b\n* x\n  y\n");
  assert.equal(insertShare("- a\n\n段落", one, { format: "task" }), "- a\n\n段落\n\n- [ ] 记一下\n");
  // 段落不接进列表
  assert.equal(insertShare("- a\n- b", one), "- a\n- b\n\n记一下\n");
  // 开头:页面以标题开头时放在标题下面
  assert.equal(insertShare("# 标题\n\n第一段\n", one, { where: "start" }), "# 标题\n\n记一下\n\n第一段\n");
  assert.equal(insertShare("\n## 标题\n- a\n- b", one, { where: "start", format: "task" }), "## 标题\n\n- [ ] 记一下\n- a\n- b\n");
  assert.equal(insertShare("只有字", one, { where: "start" }), "记一下\n\n只有字\n");
  assert.equal(insertShare("#不是标题\n", one, { where: "start" }), "记一下\n\n#不是标题\n");
  assert.equal(insertShare("# 只有标题", one, { where: "start", format: "list" }), "# 只有标题\n\n- 记一下\n");
  assert.equal(insertShare("", one, { where: "start" }), "记一下\n");
});
