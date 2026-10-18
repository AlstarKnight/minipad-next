// Bundle only mobile markup, styles and Milkdown. Desktop UI is never embedded in Android.
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const target = "mobile-dist";
rmSync(target, { recursive: true, force: true });
for (const [source, relative] of [
  ["src/mobile.html", "mobile.html"],
  ["src/mobile.css", "mobile.css"],
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
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
const size = ["mobile.html", "mobile.css", "js/mobile.js"]
  .reduce((sum, file) => sum + statSync(join(target, file)).size, 0);
console.log(`Android frontend: 3 files, ${size} bytes`);
