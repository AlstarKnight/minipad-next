// 检查各处的版本号和 package.json 里的一样(CI 用)。
// 用法:node scripts/check-version.mjs
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL("../" + file, import.meta.url), "utf8");
const version = JSON.parse(read("package.json")).version;
const lock = JSON.parse(read("package-lock.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json")).version;
const found = {
  "package-lock.json": lock.version,
  'package-lock.json 里的 packages[""]': lock.packages?.[""]?.version,
  "src-tauri/Cargo.toml": /^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"))?.[1],
  // tauri.conf.json 写的是 "../package.json":打包时直接用 package.json 里的版本号
  "src-tauri/tauri.conf.json": tauri === "../package.json" ? version : tauri,
};
const wrong = Object.entries(found).filter(([, v]) => v !== version);
for (const [file, v] of wrong) console.error(`${file} 里的版本号是 ${v},package.json 里是 ${version}`);
if (wrong.length) process.exit(1);
console.log(`版本号都是 ${version}`);
