// 构建前准备:复制前端用到的第三方库,并在缺少图标时从 app-icon.svg 生成
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

mkdirSync("src/vendor", { recursive: true });
copyFileSync("node_modules/marked/lib/marked.umd.js", "src/vendor/marked.js");
copyFileSync("node_modules/dompurify/dist/purify.min.js", "src/vendor/purify.js");
copyFileSync("node_modules/@highlightjs/cdn-assets/highlight.min.js", "src/vendor/highlight.js");

if (!existsSync("src-tauri/icons/icon.ico")) {
  execSync("npx tauri icon app-icon.svg -o src-tauri/icons", { stdio: "inherit" });
  for (const d of ["android", "ios"]) rmSync(`src-tauri/icons/${d}`, { recursive: true, force: true });
}
