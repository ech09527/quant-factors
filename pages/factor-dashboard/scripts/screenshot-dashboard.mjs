#!/usr/bin/env node
/**
 * 截图 Dashboard 用于 UI 检查：
 *   DASHBOARD_PASSWORD=xxx node scripts/screenshot-dashboard.mjs
 */
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, "../.screenshots");
const baseUrl = process.env.DASHBOARD_URL || "https://quant-factors-dashboard.pages.dev";
const password = process.env.DASHBOARD_PASSWORD || "";
const chromiumPath =
  process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/chromium";

async function shot(page, name) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${name}`);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot(page, "01-login.png");

  if (password) {
    await page.locator("#auth-password").locator("input").fill(password);
    await page.locator("#auth-form sl-button[type='submit']").click();
    await page.waitForTimeout(3500);
    await shot(page, "02-ideas.png");
    await page.locator(".tab[data-tab='validations']").click();
    await page.waitForTimeout(2000);
    await shot(page, "03-validations.png");
    await page.locator("#ideas-import-open").click();
    await page.waitForTimeout(1500);
    await shot(page, "04-import-dialog.png");
  }

  await browser.close();
  console.log(`Screenshots in ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
