import { test } from "node:test";
import assert from "node:assert/strict";
import { findExpression, formatResult } from "../src/js/calc.js";
import { fillVars, CURSOR } from "../src/js/vars.js";

const calc = (text) => findExpression(text)?.value;

test("expressions follow precedence, parentheses, powers, percent and signs", () => {
  assert.equal(calc("12*3.5"), 42);
  assert.equal(calc("1+2*3"), 7);
  assert.equal(calc("(1+2)*3"), 9);
  assert.equal(calc("2^3^2"), 512);
  assert.equal(calc("-2^2"), -4);
  assert.equal(calc("2^-1"), 0.5);
  assert.equal(calc("200*15%"), 30);
  assert.equal(calc("50%"), 0.5);
  assert.equal(calc("10-2-3"), 5);
  assert.equal(calc("8/2/2"), 2);
  assert.equal(calc("3×4÷6"), 2);
  assert.equal(calc("1,234+5"), 1239);
  assert.equal(calc("1,234.5*2"), 2469);
  // 全角的括号、数字、运算符
  assert.equal(calc("（１＋２）＊３"), 9);
  assert.equal(calc(" 1 + 2 "), 3);
});

test("the expression starts after ordinary text; plain numbers and broken ones are not expressions", () => {
  assert.deepEqual(findExpression("午饭 25+18+32"), { expr: "25+18+32", value: 75 });
  assert.equal(calc("第3章 1+2"), 3);
  assert.equal(calc("数量,3+4"), 7);
  assert.equal(calc("单价 3 合计 3*4"), 12);
  assert.equal(findExpression("1+2 3"), null);
  // 写错的不猜:括号不配对、两个数挨着
  assert.equal(findExpression("(1+2"), null);
  assert.equal(findExpression("a)1+2"), null);
  assert.equal(findExpression("2024"), null);
  assert.equal(findExpression("-5"), null);
  assert.equal(findExpression("(5)"), null);
  assert.equal(findExpression("合计"), null);
  assert.equal(findExpression(""), null);
  assert.equal(findExpression("1+"), null);
  assert.equal(findExpression("12,34+5"), null);
  assert.equal(findExpression("2(3+4)"), null);
  // 除以 0 也算找到了算式,由调用的地方提示
  assert.equal(calc("1/0"), Infinity);
});

test("results drop floating noise, keep fixed decimals and can get thousands separators", () => {
  assert.equal(formatResult(calc("0.1+0.2")), "0.3");
  assert.equal(formatResult(1 / 3), "0.3333333333");
  assert.equal(formatResult(42), "42");
  assert.equal(formatResult(100), "100");
  assert.equal(formatResult(-1e-12), "0");
  assert.equal(formatResult(2 / 3, "2"), "0.67");
  assert.equal(formatResult(5, "2"), "5.00");
  assert.equal(formatResult(-0.001, "2"), "0.00");
  assert.equal(formatResult(1234567.891, "auto", true), "1,234,567.891");
  assert.equal(formatResult(-1234, "0", true), "-1,234");
});

test("variables fill in dates, names and the cursor; unknown ones stay", () => {
  const date = new Date(2026, 9, 20, 14, 5, 9);
  const opts = { date, dateFormat: "H:mm yyyy/M/d", title: "周会", book: "工作" };
  assert.equal(fillVars("{{日期}} {{时间}} {{星期}}", opts), "2026-10-20 14:05 星期二");
  assert.equal(fillVars("{{日期时间}}", opts), "14:05 2026/10/20");
  assert.equal(fillVars("{{日期:yyyy年M月d日}} {{时间：HH.mm}}", opts), "2026年10月20日 14.05");
  assert.equal(fillVars("# {{ 标题 }}({{笔记本}})", opts), "# 周会(工作)");
  assert.equal(fillVars("{{天气}} {{日期", opts), "{{天气}} {{日期");
  assert.equal(fillVars("a{{光标}}b{{光标}}c", opts), "abc");
  assert.equal(fillVars("a{{光标}}b{{光标}}c", { ...opts, cursor: true }), `a${CURSOR}bc`);
});
