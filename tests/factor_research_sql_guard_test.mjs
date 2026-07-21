import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardSrc = path.join(root, "workers/factor-ideas/src/factor-research-sql-guard.js");
const workerDir = path.join(root, "workers/factor-ideas");

async function loadGuardModule() {
  const outDir = mkdtempSync(path.join(tmpdir(), "qf-sql-guard-"));
  const outfile = path.join(outDir, "guard.mjs");
  const build = spawnSync(
    "npx",
    ["esbuild", guardSrc, "--bundle", "--format=esm", "--platform=neutral", `--outfile=${outfile}`],
    { cwd: workerDir, encoding: "utf8" },
  );
  if (build.status !== 0) {
    rmSync(outDir, { recursive: true, force: true });
    throw new Error(build.stderr || build.stdout || "esbuild failed");
  }
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const { validateReadonlySelectSql, listAllowedResearchTables } = await loadGuardModule();

test("allows simple select on whitelist table and injects LIMIT", () => {
  const result = validateReadonlySelectSql("SELECT id, title FROM ideas");
  assert.equal(result.ok, true);
  assert.match(result.sql, /LIMIT 100$/i);
});

test("caps oversized LIMIT", () => {
  const result = validateReadonlySelectSql("SELECT * FROM ml_tasks LIMIT 999");
  assert.equal(result.ok, true);
  assert.match(result.sql, /LIMIT 100/i);
});

test("rejects multi-statement", () => {
  const result = validateReadonlySelectSql("SELECT 1 FROM ideas; DROP TABLE ideas");
  assert.equal(result.ok, false);
  assert.match(result.error, /多语句/);
});

test("rejects write / pragma keywords", () => {
  for (const sql of [
    "DELETE FROM ideas",
    "DROP TABLE ideas",
    "INSERT INTO ideas(title) VALUES('x')",
    "PRAGMA table_info(ideas)",
  ]) {
    const result = validateReadonlySelectSql(sql);
    assert.equal(result.ok, false, sql);
  }
});

test("rejects non-whitelist tables", () => {
  const result = validateReadonlySelectSql("SELECT * FROM llm_providers");
  assert.equal(result.ok, false);
  assert.match(result.error, /白名单/);
});

test("allows CTE aliases referenced in FROM/JOIN", () => {
  const result = validateReadonlySelectSql(`
    WITH top_neutralized AS (
      SELECT fv.idea_id FROM factor_validations fv LIMIT 10
    )
    SELECT * FROM top_neutralized
  `);
  assert.equal(result.ok, true);
});
