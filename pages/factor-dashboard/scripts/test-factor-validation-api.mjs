#!/usr/bin/env node
/**
 * 生产 API 冒烟测试（因子验证 + MLflow 代理）
 *
 *   source workers/factor-ideas/.env && \
 *   AUTH_PASS=$(curl -fsS -H "X-Vault-Token: $VAULT_TOKEN" \
 *     "$VAULT_ADDR/v1/kv/data/quant-factors/auth" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).data.data.PASSWORD))") \
 *   DASHBOARD_PASSWORD="$AUTH_PASS" node scripts/test-factor-validation-api.mjs
 */
import { chromium } from "playwright-core";

const baseUrl = process.env.DASHBOARD_URL || "https://quant-factors-dashboard.pages.dev";
const password = process.env.DASHBOARD_PASSWORD || process.env.AUTH_PASS || "";
const chromiumPath = process.env.CHROMIUM_PATH || "/run/current-system/sw/bin/chromium";

if (!password) {
  console.error("需要 DASHBOARD_PASSWORD 或 AUTH_PASS");
  process.exit(1);
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${password}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json };
}

async function main() {
  const checks = [];

  const list = await api("/api/factor-validations?limit=3");
  checks.push(["GET /api/factor-validations", list.status === 200 && Array.isArray(list.json.items)]);

  const settings = await api("/api/workflow/system-settings");
  const hasFvSetting = (settings.json.items || []).some((x) => x.key === "factor_validation_batch_enabled");
  checks.push(["GET system-settings has factor_validation_batch_enabled", settings.status === 200 && hasFvSetting]);

  const report = await api("/api/workflow/ml-tasks/report", {
    method: "POST",
    body: { items: [{ task_id: 1, factor_validation_id: 1, status: "pending" }] },
  });
  checks.push(["POST /api/workflow/ml-tasks/report", report.status === 200 && report.json.updated === 1]);

  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.locator("#auth-password input").fill(password);
  await page.locator("#auth-form sl-button[type='submit']").click();
  await page.waitForTimeout(3000);
  await page.locator(".tab[data-tab='settings']").click();
  await page.waitForTimeout(2000);
  const settingsText = await page.locator("#panel-settings").innerText();
  checks.push(["Dashboard 系统配置含 MLflow 调度项", /因子验证.*MLflow/.test(settingsText)]);
  await browser.close();

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(ok ? "✓" : "✗", name);
    if (!ok) failed += 1;
  }
  if (failed) process.exit(1);
  console.log("All checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
