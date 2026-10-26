// ---------- 行内计算(0.5.1) ----------
// 打 12*3.5= 再按 Tab(或者设成打 = 就算):在 = 后面写上结果,结果是普通文字。
// 支持 + - * / × ÷ ^ %(百分号,200*15% = 30)、括号(全角的也行)、小数、1,234 这样的千分位。
// 这里只有纯函数,接到编辑器上的在 expand.js

// 全角的数字和符号换成半角(一个字换一个字,位置不变)
const WIDE = { "（": "(", "）": ")", "＋": "+", "－": "-", "＊": "*", "／": "/", "＾": "^", "％": "%" };
function normalize(s) {
  return s.replace(/[０-９（）＋－＊／＾％]/g, (c) => WIDE[c] ?? String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

// 算式里能出现的字
const ALLOWED = /[0-9.,+\-*/×÷^%() \t]/;
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d*)?|\.\d+/y;

function tokenize(s) {
  const out = [];
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (m) {
      out.push(Number(m[0].replace(/,/g, "")));
      i += m[0].length;
    } else if ("+-*/×÷^%()".includes(c)) {
      out.push(c);
      i++;
    } else return null;
  }
  return out;
}

// 算出结果;写错了(括号不配对、两个数挨着……)返回 null。ops 是做了几次运算,只有一个数的不算算式
function evaluate(tokens) {
  let i = 0;
  let ops = 0;
  const peek = () => tokens[i];
  const expr = () => {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = tokens[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
      ops++;
    }
    return v;
  };
  const term = () => {
    let v = unary();
    while (["*", "/", "×", "÷"].includes(peek())) {
      const op = tokens[i++];
      const r = unary();
      v = op === "*" || op === "×" ? v * r : v / r;
      ops++;
    }
    return v;
  };
  // -2^2 = -4,2^-1 = 0.5
  const unary = () => {
    if (peek() === "-" || peek() === "+") return tokens[i++] === "-" ? -unary() : unary();
    return power();
  };
  const power = () => {
    const v = postfix();
    if (peek() !== "^") return v;
    i++;
    ops++;
    return v ** unary();
  };
  const postfix = () => {
    let v = primary();
    while (peek() === "%") {
      i++;
      v /= 100;
      ops++;
    }
    return v;
  };
  const primary = () => {
    const t = tokens[i++];
    if (typeof t === "number") return t;
    if (t !== "(") throw 0;
    const v = expr();
    if (tokens[i++] !== ")") throw 0;
    return v;
  };
  try {
    const value = expr();
    return i === tokens.length ? { value, ops } : null;
  } catch {
    return null;
  }
}

// 算式可以从空格或者逗号(不是千分位的)后面开始:「单价 3 合计 3*4」里只算 3*4
const boundary = (s, i) => /\s/.test(s[i - 1]) || (s[i - 1] === "," && !/\d/.test(s[i - 2] ?? ""));

// text 是 = 前面的文字。从 = 往前找最长的算式(前面的文字不算),
// 返回 { expr, value };value 不是有限的数(比如除以 0)时由调用的地方提示。找不到算式返回 null
export function findExpression(text) {
  const s = normalize(text.slice(-200));
  let start = s.length;
  while (start > 0 && ALLOWED.test(s[start - 1])) start--;
  for (let i = start; i < s.length; i++) {
    if ((i > start && !boundary(s, i)) || !/[0-9.(+\-]/.test(s[i])) continue;
    const tokens = tokenize(s.slice(i));
    const r = tokens && evaluate(tokens);
    if (r) return r.ops ? { expr: s.slice(i).trim(), value: r.value } : null;
  }
  return null;
}

// 结果写成文字:decimals 是 "auto"(最多 10 位小数,去掉末尾的 0)或者固定几位;thousands 加千分位逗号
export function formatResult(value, decimals = "auto", thousands = false) {
  let s;
  if (/^[0-6]$/.test(String(decimals))) s = value.toFixed(Number(decimals));
  else {
    // 先去掉浮点数的误差(0.1+0.2 是 0.30000000000000004)
    s = String(Number(value.toPrecision(15)));
    if (s.includes("e") || (s.split(".")[1]?.length ?? 0) > 10) {
      s = Number(s).toFixed(10);
      if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
    }
  }
  if (Number(s) === 0) s = s.replace(/^-/, "");
  if (thousands) s = s.replace(/^(-?)(\d+)/, (_, sign, int) => sign + int.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  return s;
}
