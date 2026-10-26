// ---------- 按名字找页面:Ctrl+P 快速切换和 [[ 补全共用(0.5.0) ----------
// 打的词要对上页面名:名字完全一样的最靠前,然后是名字开头、拼音从头对上、名字里包含、拼音从中间对上;
// 都对不上时看笔记本名,最后是按顺序出现(中间可以隔着别的字)。
// 拼音可以打全拼、首字母或者混着打:kf、kaifa、kaif、开f 都能找到「开发」
import { dict } from "../vendor/pinyin.js";

// 每个常用汉字的拼音(多音字有几个),第一次用到时才从拼音表倒过来建
let readings = null;
function readingsOf(ch) {
  if (!readings) {
    readings = new Map();
    for (const [py, chars] of Object.entries(dict)) {
      for (const c of chars) {
        const list = readings.get(c);
        if (!list) readings.set(c, [py]);
        else if (!list.includes(py)) list.push(py);
      }
    }
  }
  return readings.get(ch);
}

// 名字拆成一个个字(小写,带拼音),按名字记下来,几千个页面每打一个字都要比一遍
const infos = new Map();
function info(name) {
  let x = infos.get(name);
  if (!x) {
    const lower = name.toLowerCase();
    const chars = [...lower].map((c) => ({ c, py: readingsOf(c), skip: !/[\p{L}\p{N}]/u.test(c) }));
    x = { lower, chars, han: chars.some((c) => c.py) };
    infos.set(name, x);
  }
  return x;
}

// 从名字的第 i 个字起能不能拼出 t 从 j 起的部分:每个字可以用它本身,或者它某个读音的开头几个字母;
// 中间的空格和标点可以跳过。memo 记下算过的 (i, j):1 能,2 不能
function spell(chars, i, t, j, memo) {
  if (j === t.length) return true;
  if (i === chars.length) return false;
  const k = i * (t.length + 1) + j;
  if (memo[k]) return memo[k] === 1;
  const ch = chars[i];
  let ok = (ch.c === t[j] && spell(chars, i + 1, t, j + 1, memo)) || (ch.skip && spell(chars, i + 1, t, j, memo));
  for (const py of ch.py || []) {
    for (let n = 1; !ok && n <= py.length && j + n <= t.length && py[n - 1] === t[j + n - 1]; n++) {
      ok = spell(chars, i + 1, t, j + n, memo);
    }
    if (ok) break;
  }
  memo[k] = ok ? 1 : 2;
  return ok;
}

// 按拼音对上时从第几个字开始,对不上是 -1
function pinyinAt(x, term) {
  const t = [...term];
  const memo = new Uint8Array((x.chars.length + 1) * (t.length + 1));
  for (let i = 0; i < x.chars.length; i++) {
    const ch = x.chars[i];
    if (ch.skip || (ch.c !== t[0] && !ch.py?.some((p) => p[0] === t[0]))) continue;
    if (spell(x.chars, i, t, 0, memo)) return i;
  }
  return -1;
}

// s 里能不能按顺序找到 t 的每个字(中间可以隔着别的字)
function inOrder(s, t) {
  let i = 0;
  for (const ch of s) if (ch === t[i]) i++;
  return i === t.length;
}

// 一个词(小写)对名字的分数,对不上是 0
export function nameScore(name, term, pinyin = true) {
  const x = info(name);
  if (x.lower === term) return 5;
  if (x.lower.startsWith(term)) return 4;
  const at = pinyin && x.han && /[a-z]/.test(term) ? pinyinAt(x, term) : -1;
  if (at === 0) return 3.5;
  if (x.lower.includes(term)) return 3;
  if (at > 0) return 2.5;
  return 0;
}

// 页面的总分:每个词都要对上页面名或者笔记本名(label),有一个对不上就是 -1
export function pageScore(name, label, terms, pinyin = true) {
  let total = 0;
  for (const t of terms) {
    const s = nameScore(name, t, pinyin);
    if (s) total += s;
    else if (nameScore(label, t, pinyin)) total += 1;
    else if (inOrder(info(name).lower, t)) total += 0.5;
    else return -1;
  }
  return total;
}

// 把输入拆成词(小写,空白分开)
export function termsOf(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}
