// 构建前准备:复制前端用到的第三方库,把 Milkdown 打包成一个文件,并在缺少图标时从 app-icon.svg 生成
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { build } from "esbuild";

mkdirSync("src/vendor", { recursive: true });
// highlight.js 自带常用的 30 多种语言,再加上几种 Windows 上常用、默认没带的
const HLJS = "node_modules/@highlightjs/cdn-assets";
const EXTRA_LANGUAGES = ["powershell", "dos", "dockerfile", "nginx", "properties", "cmake", "protobuf", "dart", "scala", "haskell", "elixir", "groovy", "latex", "matlab", "vim"];
writeFileSync(
  "src/vendor/highlight.js",
  [readFileSync(`${HLJS}/highlight.min.js`, "utf8"), ...EXTRA_LANGUAGES.map((l) => readFileSync(`${HLJS}/languages/${l}.min.js`, "utf8"))].join("\n")
);

// Milkdown 由很多个 npm 包组成(还用到 ProseMirror 和 remark),浏览器没法直接按包名导入,所以打成一个 ES 模块。
// 用到的包都是 MIT 许可证,许可证放在文件开头。
const license = readFileSync("node_modules/@milkdown/kit/LICENSE", "utf8").trim();
rmSync("src/vendor/codemirror.js", { force: true });
await build({
  entryPoints: ["scripts/milkdown.mjs"],
  outfile: "src/vendor/milkdown.js",
  bundle: true,
  format: "esm",
  minify: true,
  target: "chrome110",
  legalComments: "none",
  banner: { js: `/*! Milkdown(@milkdown/kit,含 ProseMirror 和 remark),由 scripts/prepare.mjs 打包\n\n${license}\n*/` },
  logLevel: "warning",
});

if (!existsSync("src-tauri/icons/icon.ico")) {
  execSync("npx tauri icon app-icon.svg -o src-tauri/icons", { stdio: "inherit" });
  for (const d of ["android", "ios"]) rmSync(`src-tauri/icons/${d}`, { recursive: true, force: true });
}
