import { test } from "node:test";
import assert from "node:assert/strict";
import { findPageLinks, parseTarget, makeIndex, resolveTarget, retarget, linkable, fileName } from "../src/js/pagelinks.js";
import { nameScore, pageScore, termsOf } from "../src/js/match.js";

const index = makeIndex([
  { name: "", pages: ["周报", "README", "开发计划"] },
  { name: "工作", pages: ["计划", "周报"] },
  { name: "Life", pages: ["旅行"] },
]);

test("links are found with their targets; empty and bracketed ones are not links", () => {
  const text = "看 [[周报]] 和 [[工作/计划]]，[[ ]] [[/]] [[a[b]] [[多\n行]] [[ 旅行 ]]";
  assert.deepEqual(findPageLinks(text).map((l) => [text.slice(l.from, l.to), l.target]), [
    ["[[周报]]", "周报"],
    ["[[工作/计划]]", "工作/计划"],
    ["[[ 旅行 ]]", " 旅行 "],
  ]);
  assert.deepEqual(parseTarget(" 工作 / 计划 "), { book: "工作", page: "计划" });
  assert.deepEqual(parseTarget("a/b/c"), { book: "a", page: "b/c" });
  assert.equal(linkable("笔记[1]"), false);
  assert.equal(linkable("笔记 1"), true);
});

test("targets resolve in the same notebook first, by notebook name, or 默认; case and spaces do not matter", () => {
  assert.deepEqual(resolveTarget(index, "周报", "工作"), { book: "工作", page: "周报", exists: true });
  assert.deepEqual(resolveTarget(index, "默认/周报", "工作"), { book: "", page: "周报", exists: true });
  assert.deepEqual(resolveTarget(index, " life / 旅行 ", ""), { book: "Life", page: "旅行", exists: true });
  assert.deepEqual(resolveTarget(index, "readme", ""), { book: "", page: "README", exists: true });
  assert.deepEqual(resolveTarget(index, "没有", ""), { book: "", page: "没有", exists: false });
  assert.deepEqual(resolveTarget(index, "没有的本/x", ""), { book: null, bookLabel: "没有的本", page: "x", exists: false });
});

test("names the system does not allow resolve to the page the backend created for them", () => {
  // 和 notes.rs 的 clean_name 一样
  assert.equal(fileName("a?b:c*"), "a_b_c_");
  assert.equal(fileName("v1.0.."), "v1.0");
  assert.equal(fileName(".隐藏"), "_隐藏");
  assert.equal(fileName("con"), "con_");
  assert.equal(fileName("COM1.txt"), "COM1_.txt");
  assert.equal(fileName("x".repeat(90)), "x".repeat(80));
  assert.equal(fileName("..."), "");
  const idx = makeIndex([{ name: "", pages: ["a_b", "Mr", "con_"] }]);
  assert.deepEqual(resolveTarget(idx, "a?b", ""), { book: "", page: "a_b", exists: true });
  assert.deepEqual(resolveTarget(idx, "Mr.", ""), { book: "", page: "Mr", exists: true });
  assert.deepEqual(resolveTarget(idx, "CON", ""), { book: "", page: "con_", exists: true });
  // 起不出名字的不算链接
  assert.deepEqual(findPageLinks("[[...]] [[ . ]]"), []);
  // 改名时这样的链接也跟着改;名字没变的不动
  assert.equal(retarget("[[a?b]]", { book: "", page: "Mr" }, idx, { page: ["", "a_b", "新"] }), "[[新]]");
  assert.equal(retarget("[[a?b]]", { book: "", page: "Mr" }, idx, { page: ["", "Mr", "新"] }), "[[a?b]]");
});

test("renaming a page rewrites links to it in the same form, leaves code, broken and other links alone", () => {
  const md = [
    "[[周报]] [[默认/周报]] [[ 周报 ]] [[周报1]]",
    "`[[周报]]`",
    "```",
    "[[周报]]",
    "```",
    "\\[\\[周报]] 旧版本保存的",
    "[[工作/周报]]",
  ].join("\n");
  const out = retarget(md, { book: "", page: "开发计划" }, index, { page: ["", "周报", "每周总结"] });
  assert.equal(out, [
    "[[每周总结]] [[默认/每周总结]] [[每周总结]] [[周报1]]",
    "`[[周报]]`",
    "```",
    "[[周报]]",
    "```",
    "[[每周总结]] 旧版本保存的",
    "[[工作/周报]]",
  ].join("\n"));
  // 别的笔记本里写了笔记本名的也改,同名的另一页不动
  assert.equal(retarget("[[默认/周报]] [[周报]]", { book: "工作", page: "计划" }, index, { page: ["", "周报", "每周总结"] }),
    "[[默认/每周总结]] [[周报]]");
  // 只改大小写:链接照样对得上,不用改
  assert.equal(retarget("[[readme]]", { book: "", page: "周报" }, index, { page: ["", "README", "Readme"] }), "[[readme]]");
  // 新名字里要转义的字符照保存时的写法转义
  assert.equal(retarget("[[周报]]", { book: "", page: "x" }, index, { page: ["", "周报", "_草稿_ A&B a_b"] }),
    "[[\\_草稿\\_ A\\&B a_b]]");
});

test("renaming a notebook rewrites links that name it; short links inside it stay", () => {
  const change = { book: ["工作", "工作2"] };
  assert.equal(retarget("[[工作/计划]] [[周报]]", { book: "", page: "周报" }, index, change), "[[工作2/计划]] [[周报]]");
  assert.equal(retarget("[[计划]] [[工作/周报]] [[默认/周报]]", { book: "工作", page: "周报" }, index, change),
    "[[计划]] [[工作2/周报]] [[默认/周报]]");
});

test("moving a page to another notebook: links to it follow, its own short links keep pointing home", () => {
  const change = { move: ["", "开发计划", "工作", "开发计划"] };
  // 原来笔记本里的短链接补上新笔记本名
  assert.equal(retarget("[[开发计划]]", { book: "", page: "周报" }, index, change), "[[工作/开发计划]]");
  // 新笔记本里写了笔记本名的照样写笔记本名
  assert.equal(retarget("[[默认/开发计划]]", { book: "工作", page: "计划" }, index, change), "[[工作/开发计划]]");
  // 移走的那一页:指向原来笔记本的短链接补上原笔记本名;指向自己的仍是短的;不存在的不动
  assert.equal(retarget("[[周报]] [[开发计划]] [[没有]] [[工作/计划]]", { book: "", page: "开发计划" }, index, change),
    "[[默认/周报]] [[开发计划]] [[没有]] [[工作/计划]]");
  // 那边重名换了名字
  assert.equal(retarget("[[开发计划]]", { book: "", page: "周报" }, index, { move: ["", "开发计划", "工作", "开发计划 (2)"] }),
    "[[工作/开发计划 (2)]]");
});

test("page names match by prefix, substring, pinyin (full, initials, mixed) and in order", () => {
  assert.equal(nameScore("开发", "开发"), 5);
  assert.equal(nameScore("开发计划", "开发"), 4);
  for (const t of ["kf", "kaifa", "kaif", "开f", "kfjh", "kaifajihua"]) assert.equal(nameScore("开发计划", t), 3.5, t);
  assert.equal(nameScore("我的开发计划", "开发"), 3);
  assert.equal(nameScore("我的开发计划", "kfjh"), 2.5);
  // 多音字:行 xing / hang
  assert.equal(nameScore("银行卡", "yhk"), 3.5);
  assert.equal(nameScore("行动", "xd"), 3.5);
  // 空格和标点可以跳过
  assert.equal(nameScore("React 笔记", "reactbj"), 3.5);
  assert.equal(nameScore("开发计划", "kx"), 0);
  assert.equal(nameScore("开发计划", "kf", false), 0);
  assert.equal(pageScore("计划", "工作", termsOf("gz jh")), 1 + 3.5);
  assert.equal(pageScore("开发计划", "", termsOf("开计")), 0.5);
  assert.equal(pageScore("开发计划", "", termsOf("开发 xyz")), -1);
});
