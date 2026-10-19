// Windows WebDAV settings UI and browser-preview protocol mock.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { serve } from "../scripts/serve.mjs";

let server, browser, url;
before(async () => {
  server = await serve(fileURLToPath(new URL("../src/", import.meta.url)));
  url = `http://127.0.0.1:${server.address().port}/index.html`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

test("WebDAV settings persist without storing password and manual test reports result", async () => {
  const context = await browser.newContext({ viewport: { width: 650, height: 650 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", err => errors.push(String(err)));
  try {
    await page.goto(url);
    await page.locator("#btn-settings").click();
    await page.locator('#set-nav [data-page="data"]').click();
    assert.equal(await page.locator("#set-webdav-enabled").isChecked(), false);
    assert.equal(await page.locator("#set-webdav-color + .shared-colors").count(), 1,
      "WebDAV status color uses the shared color library");
    assert.equal(await page.locator("#set-local-path-color + .shared-colors").count(), 1,
      "file path color uses the same shared color library");
    await page.locator("#set-webdav-server").fill("https://dav.example.com/dav/");
    await page.locator("#set-webdav-user").fill("tester");
    await page.locator("#set-webdav-password").fill("never-serialize-this");
    await page.locator("#set-webdav-enabled").check();
    await page.locator("#set-webdav-interval").selectOption("0");
    await page.locator("#set-save").click();
    await page.waitForFunction(() => {
      const db = JSON.parse(localStorage.getItem("minipad-next-demo") || "{}");
      return db.settings?.webdav_enabled === true;
    });
    const saved = await page.evaluate(() => localStorage.getItem("minipad-next-demo"));
    assert.equal(saved.includes("never-serialize-this"), false);
    await page.locator("#btn-settings").click();
    await page.locator('#set-nav [data-page="data"]').click();
    assert.equal(await page.locator("#set-webdav-enabled").isChecked(), true);
    assert.equal(await page.locator("#set-webdav-password").inputValue(), "");
    await page.locator("#set-webdav-test").click();
    await page.waitForFunction(() => document.querySelector("#toast")?.textContent?.includes("连接成功"));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
