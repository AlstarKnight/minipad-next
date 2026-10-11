// 打印 CHANGELOG.md 里某个版本那一节的内容,用作 Release 说明。
// 用法:node scripts/release-notes.mjs 0.2.3
import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("用法:node scripts/release-notes.mjs <版本号>");
  process.exit(1);
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md 里没有 ## ${version} 这一节`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
if (end < 0) end = lines.length;
console.log(lines.slice(start + 1, end).join("\n").trim());
