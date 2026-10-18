// Mobile uses the same Milkdown/vendor Markdown engine and desktop extension styles.
// Keep all editor features, but exclude desktop-only window lifecycle and overlays.
import "./prepare.mjs";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const target = "mobile-dist";
rmSync(target, { recursive: true, force: true });
for (const [source, relative] of [
  ["src/mobile.html", "mobile.html"],
  ["src/mobile.css", "mobile.css"],
  ["src/style.css", "desktop-editor.css"],
  ["src/vendor/highlight.js", "vendor/highlight.js"],
]) {
  const destination = join(target, relative);
  mkdirSync(join(destination, ".."), { recursive: true });
  copyFileSync(source, destination);
}
await build({
  entryPoints: ["src/js/mobile.js"],
  outfile: join(target, "js/mobile.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome110",
  minify: false,
  legalComments: "inline",
  logLevel: "warning",
});
const size = ["mobile.html", "mobile.css", "desktop-editor.css", "vendor/highlight.js", "js/mobile.js"]
  .reduce((sum, file) => sum + statSync(join(target, file)).size, 0);
console.log(`Android desktop-parity editor frontend: 5 files, ${size} bytes`);
