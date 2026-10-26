// The Android build only runs on PRs that change something the APK is made from
// (pull_request.paths in .github/workflows/android.yml). These tests work out which files really
// go into the APK and check the path list against them in both directions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const list = (dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).map((name) => `${dir}/${name}`);

// Scripts and npm packages the mobile frontend is generated from (src/vendor is not in git:
// prepare.mjs builds it from npm packages, the Milkdown bundle from scripts/milkdown.mjs).
const TOOLING = ["scripts/prepare.mjs", "scripts/prepare-mobile.mjs", "scripts/milkdown.mjs",
                 "package.json", "package-lock.json", ".github/workflows/android.yml"];
const RUST_CONFIG = ["Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json", "tauri.android.conf.json",
                     "capabilities/default.json", "icons/icon.png"].map((f) => `src-tauri/${f}`);

function workflowPaths() {
  const lines = read(".github/workflows/android.yml").split("\n");
  const at = lines.indexOf("    paths:", lines.indexOf("  pull_request:"));
  const paths = [];
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^ {6}- '([^']+)'$/);
    if (!m) break;
    paths.push(m[1]);
  }
  assert.ok(paths.length, "no pull_request.paths found in android.yml");
  return paths;
}

// GitHub's filter syntax as used here: * stays inside one folder, ** crosses folders,
// a leading ! excludes, and the last matching line decides
const toRegExp = (glob) =>
  new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*?/g, (m) => (m === "**" ? ".*" : "[^/]*")) + "$");
function triggers(file, patterns) {
  let hit = false;
  for (const p of patterns) {
    const exclude = p.startsWith("!");
    if (toRegExp(exclude ? p.slice(1) : p).test(file)) hit = !exclude;
  }
  return hit;
}

async function mobileBundleInputs() {
  const result = await build({
    entryPoints: ["src/js/mobile.js"], absWorkingDir: root, bundle: true, format: "esm",
    platform: "browser", write: false, metafile: true, outfile: "out.js", logLevel: "error",
  });
  return Object.keys(result.metafile.inputs).filter((f) => !f.startsWith("src/vendor/"));
}

// lib.rs is the crate the APK is built from: every module it declares outside #[cfg(desktop)]
function androidRustFiles() {
  const lines = read("src-tauri/src/lib.rs").split("\n");
  const modules = lines.flatMap((line, i) => {
    const m = line.match(/^mod (\w+);/);
    return m && lines[i - 1]?.trim() !== "#[cfg(desktop)]" ? [`src-tauri/src/${m[1]}.rs`] : [];
  });
  return ["src-tauri/src/lib.rs", "src-tauri/src/main.rs", ...modules];
}

async function apkInputs() {
  const copied = [...read("scripts/prepare-mobile.mjs").matchAll(/\["(src\/[^"]+)",/g)]
    .map((m) => m[1])
    .filter((f) => !f.startsWith("src/vendor/"));
  return [...await mobileBundleInputs(), ...copied, ...androidRustFiles(), ...RUST_CONFIG, ...TOOLING];
}

test("every file the APK is made from triggers the Android build", async () => {
  const patterns = workflowPaths();
  const inputs = await apkInputs();
  assert.ok(inputs.includes("src/js/editor.js") && inputs.includes("src-tauri/src/mobile.rs") && inputs.includes("src/mobile.html"));
  const missing = inputs.filter((f) => !triggers(f, patterns));
  assert.deepEqual(missing, [],
    "android.yml pull_request.paths misses files that go into the APK; add a line for each " +
    "(or remove the '!' line that excludes it):\n" + missing.join("\n"));
});

test("desktop-only files do not trigger the Android build", async () => {
  const patterns = workflowPaths();
  const inputs = new Set(await apkInputs());
  const desktopOnly = [
    ...list("src/js").filter((f) => !inputs.has(f)),
    ...list("src-tauri/src").filter((f) => !inputs.has(f)),
    "src/index.html", "src/ball.html", ...list("tests"),
    "README.md", "CHANGELOG.md", "docs/android.md", ".github/workflows/build.yml",
  ];
  assert.ok(desktopOnly.includes("src/js/main.js") && desktopOnly.includes("src-tauri/src/desktop.rs"));
  const extra = desktopOnly.filter((f) => triggers(f, patterns));
  assert.deepEqual(extra, [],
    "these files are not part of the APK, so a PR that only changes them should not build it; " +
    "exclude each in android.yml with a '!' line:\n" + extra.join("\n"));
});
