// 分享到 Minipad(0.5.5):分享的内容怎么拆开、写成什么样、放在页面的哪里
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShared, shareLines, shareBlock, insertShare, shareSkippedText } from "../src/js/share.js";

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

// 附件链接(0.5.6):电脑上拖进来的文件、手机上分享来的文件
test("attachment links show the name and the size; Markdown marks are escaped, spaces go inside <>", async () => {
  const { sizeText, attachmentLabel, attachmentMarkdown, imageMarkdown } = await import("../src/js/attachments.js");
  assert.deepEqual([0, 800, 1024, 350 * 1024, 1.24 * 1024 * 1024, 50 * 1024 * 1024, 3 * 1024 ** 3].map(sizeText),
    ["0 B", "800 B", "1 KB", "350 KB", "1.2 MB", "50 MB", "3 GB"]);
  assert.equal(attachmentLabel("季度报告.pdf", 1.2 * 1024 * 1024), "📎 季度报告.pdf（1.2 MB）");
  assert.equal(attachmentLabel("季度报告.pdf", 1.2 * 1024 * 1024, { size: false }), "📎 季度报告.pdf");
  assert.equal(attachmentLabel("季度报告.pdf", 1.2 * 1024 * 1024, { clip: false }), "季度报告.pdf（1.2 MB）");
  assert.equal(attachmentMarkdown("assets/季度报告.pdf", "季度报告.pdf", 1.2 * 1024 * 1024), "[📎 季度报告.pdf（1.2 MB）](assets/季度报告.pdf)");
  assert.equal(attachmentMarkdown("assets/季度 报告(1).pdf", "季度 报告(1).pdf", 10, { size: false }), "[📎 季度 报告(1).pdf](<assets/季度 报告(1).pdf>)");
  assert.equal(attachmentMarkdown("assets/a_[b]*.zip", "a_[b]*.zip", 1, { clip: false, size: false }), "[a\\_\\[b\\]\\*.zip](assets/a_[b]*.zip)");
  assert.equal(imageMarkdown("assets/img-20261101-130501.jpg"), "![](assets/img-20261101-130501.jpg)");
});

// 分享图片和文件(0.5.6):一个一行,默认在文字下面,可以放到上面;时间加在最前面那一行;每一条照样是段落、列表项或待办
test("shared images and files are one line each, below the text or above it, with the time on the first line", () => {
  const media = ["![](assets/img-20261101-130501.jpg)", "[📎 季度报告.pdf（1.2 MB）](assets/季度报告.pdf)"];
  assert.deepEqual(shareLines({ text: "看这个 https://x.y", title: "" }, { date, media }),
    [`${STAMP} [看这个](https://x.y)`, ...media]);
  assert.deepEqual(shareLines({ text: "说明" }, { date, media, mediaFirst: true }),
    [`${STAMP} ${media[0]}`, media[1], "说明"]);
  // 只有图片和文件
  assert.deepEqual(shareLines({}, { date, media, stamp: false }), media);
  assert.deepEqual(shareLines({ text: " " }, { date, media: [] }), []);
  assert.equal(shareBlock(shareLines({ text: "两张" }, { date, media: media.slice(0, 1), stamp: false }), "task"), "- [ ] 两张\n  ![](assets/img-20261101-130501.jpg)");
  assert.equal(insertShare("# 收集箱\n\n旧的", shareLines({}, { date, media, stamp: false }), { where: "start" }),
    `# 收集箱\n\n${media[0]}\n${media[1]}\n\n旧的\n`);
});

test("files that were not saved are listed with the reason, grouped when there are many", () => {
  assert.equal(shareSkippedText([{ name: "大.mp4", reason: "超过 50 MB" }]), "「大.mp4」没存(超过 50 MB)");
  assert.equal(shareSkippedText([
    { name: "a.pdf", reason: "接收文件已关闭" }, { name: "b.zip", reason: "接收文件已关闭" },
    ...[1, 2, 3].map((n) => ({ name: `IMG_${n}.jpg`, reason: "一次最多 20 个" })),
  ]), "「a.pdf」「b.zip」没存(接收文件已关闭);「IMG_1.jpg」等 3 个没存(一次最多 20 个)");
  assert.equal(shareSkippedText([]), "");
});
