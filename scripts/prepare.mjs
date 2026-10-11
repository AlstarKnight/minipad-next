// 构建前准备:复制前端用到的第三方库,把 CodeMirror 打包成一个文件,并在缺少图标时从 app-icon.svg 生成
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { build } from "esbuild";

mkdirSync("src/vendor", { recursive: true });
copyFileSync("node_modules/marked/lib/marked.umd.js", "src/vendor/marked.js");
copyFileSync("node_modules/dompurify/dist/purify.min.js", "src/vendor/purify.js");
copyFileSync("node_modules/@highlightjs/cdn-assets/highlight.min.js", "src/vendor/highlight.js");

// CodeMirror 由很多个 npm 包组成,浏览器没法直接按包名导入,所以打成一个 ES 模块。
// 许可证(MIT)放在文件开头,@codemirror 和 @lezer 的包是同一份许可证。
const license = readFileSync("node_modules/@codemirror/view/LICENSE", "utf8").trim();
await build({
  entryPoints: ["scripts/codemirror.mjs"],
  outfile: "src/vendor/codemirror.js",
  bundle: true,
  format: "esm",
  minify: true,
  target: "chrome110",
  legalComments: "none",
  banner: { js: `/*! CodeMirror 6 和 Lezer(@codemirror/*、@lezer/*),由 scripts/prepare.mjs 打包\n\n${license}\n*/` },
  logLevel: "warning",
});

if (!existsSync("src-tauri/icons/icon.ico")) {
  execSync("npx tauri icon app-icon.svg -o src-tauri/icons", { stdio: "inherit" });
  for (const d of ["android", "ios"]) rmSync(`src-tauri/icons/${d}`, { recursive: true, force: true });
}
