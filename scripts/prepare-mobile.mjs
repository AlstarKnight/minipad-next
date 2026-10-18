// Android only needs the standalone local Markdown shell in PR #38.
// Keep the desktop Milkdown bundle and Windows UI out of the APK.
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const target = "mobile-dist";
const files = [
  ["src/mobile.html", "mobile.html"],
  ["src/mobile.css", "mobile.css"],
  ["src/js/mobile.js", "js/mobile.js"],
];

rmSync(target, { recursive: true, force: true });
let bytes = 0;
for (const [source, relative] of files) {
  const destination = join(target, relative);
  mkdirSync(join(destination, ".."), { recursive: true });
  copyFileSync(source, destination);
  bytes += statSync(destination).size;
}
console.log(`Android frontend: ${files.length} files, ${bytes} bytes`);
