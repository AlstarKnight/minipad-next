// 在本机起一个小网页服务器打开 src/,用浏览器预览界面(用的是模拟后端,数据存在浏览器里)。
// 前端用了 ES 模块,直接双击 index.html(file://)打不开,所以需要它。界面测试也用它。
// 用法:npm run preview [端口],然后打开显示的地址。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// 页面带上和程序里一样的 CSP,在 Tauri 里会被拦下的写法(比如内联脚本)在浏览器里也会报错
const CONF = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
const CSP = JSON.parse(readFileSync(CONF, "utf8")).app?.security?.csp;

/** 把 `root` 文件夹当网站根目录,`port` 为 0 时随便挑一个空闲端口;返回已经开始监听的 server */
export function serve(root, port = 0) {
  root = resolve(root);
  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (path === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    const file = normalize(join(root, path.endsWith("/") ? path + "index.html" : path));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      const type = TYPES[extname(file).toLowerCase()] || "application/octet-stream";
      const headers = { "Content-Type": type, "Cache-Control": "no-store" };
      if (CSP && type.startsWith("text/html")) headers["Content-Security-Policy"] = CSP;
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}

// 直接运行这个文件时启动预览
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 5173;
  const server = await serve(fileURLToPath(new URL("../src/", import.meta.url)), port);
  console.log(`界面预览:http://127.0.0.1:${server.address().port}/  (按 Ctrl+C 退出)`);
}
