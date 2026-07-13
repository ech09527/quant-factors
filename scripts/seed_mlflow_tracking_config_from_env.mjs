#!/usr/bin/env node
/**
 * 从 workers/factor-ideas/.env 或仓库根 .env 读取 MLFLOW_*，向 D1 插入一条启用的 tracking 配置。
 * 用法：node scripts/seed_mlflow_tracking_config_from_env.mjs [--remote]
 */
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

const remote = process.argv.includes("--remote");
const envFromWorker = loadEnvFile(join(repoRoot, "workers/factor-ideas/.env"));
const envFromRoot = loadEnvFile(join(repoRoot, ".env"));
const env = { ...envFromRoot, ...envFromWorker };

const trackingUri = (
  env.MLFLOW_TRACKING_URI?.trim() ||
  env.MLFLOW_TRACKING_URL?.trim() ||
  ""
).replace(/\/$/, "");
const username =
  env.MLFLOW_TRACKING_USERNAME?.trim() || env.DAGSHUB_USER?.trim() || "";
const password =
  env.MLFLOW_TRACKING_PASSWORD?.trim() || env.DAGSHUB_TOKEN?.trim() || "";

if (!trackingUri || !username || !password) {
  console.error(
    "缺少 MLFLOW_TRACKING_URI / MLFLOW_TRACKING_USERNAME / MLFLOW_TRACKING_PASSWORD（或 DAGSHUB_*）"
  );
  process.exit(1);
}

const key = "dagshub-quant";
const name = "DagsHub quant.mlflow";

const sql = `
INSERT INTO mlflow_tracking_configs
  (key, name, tracking_uri, username, password, enabled, sort_order)
VALUES
  (${sqlString(key)}, ${sqlString(name)}, ${sqlString(trackingUri)}, ${sqlString(username)}, ${sqlString(password)}, 1, 0)
ON CONFLICT(key) DO UPDATE SET
  name = excluded.name,
  tracking_uri = excluded.tracking_uri,
  username = excluded.username,
  password = excluded.password,
  enabled = 1,
  updated_at = datetime('now');
UPDATE mlflow_tracking_configs
   SET enabled = 0, updated_at = datetime('now')
 WHERE key != ${sqlString(key)} AND enabled = 1;
`.trim();

const workerDir = join(repoRoot, "workers/factor-ideas");
const remoteFlag = remote ? " --remote" : "";
const tmpSql = join(tmpdir(), `mlflow-seed-${Date.now()}.sql`);
writeFileSync(tmpSql, `${sql}\n`, "utf8");
const cmd = `cd ${JSON.stringify(workerDir)} && npx wrangler d1 execute quant-factors${remoteFlag} --file ${JSON.stringify(tmpSql)}`;

console.log(`Seeding mlflow_tracking_configs key=${key} (${remote ? "remote" : "local"})`);
try {
  execSync(cmd, { stdio: "inherit" });
  console.log("Done.");
} finally {
  unlinkSync(tmpSql);
}
