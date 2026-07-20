import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbSrc = readFileSync(
  path.join(root, "workers/factor-ideas/src/factor-validation-db.js"),
  "utf8"
);
const dispatchSrc = readFileSync(
  path.join(root, "workers/factor-ideas/src/prefect-neutral-execution-dispatch.js"),
  "utf8"
);
const settingsSrc = readFileSync(
  path.join(root, "workers/factor-ideas/src/workflow-settings.js"),
  "utf8"
);

test("factor_validations schema migration adds neutralization_key", () => {
  const migration = readFileSync(
    path.join(root, "workers/factor-ideas/migrations/0018_factor_validation_neutralization.sql"),
    "utf8"
  );
  assert.match(migration, /neutralization_key/);
  assert.match(migration, /UNIQUE \(idea_id, profile_key, neutralization_key\)/);
  assert.match(migration, /neutral_validation_batch_enabled/);
});

test("primary pending jobs filter neutralization_key none", () => {
  assert.match(dbSrc, /fv\.neutralization_key = '\$\{PRIMARY_NEUTRALIZATION_KEY\}'/);
  assert.match(dbSrc, /listPendingFactorNeutralValidationJobsForPrefect/);
  assert.match(dbSrc, /mt_primary\.status = 'success'/);
  assert.match(dbSrc, /ABS\(/);
});

test("neutral dispatch uses factor_neutral_validation business type", () => {
  assert.match(dispatchSrc, /BUSINESS_TYPE_FACTOR_NEUTRAL_VALIDATION/);
  assert.match(dispatchSrc, /business_type: BUSINESS_TYPE_FACTOR_NEUTRAL_VALIDATION/);
  assert.match(dispatchSrc, /getNeutralValidationBatchEnabled/);
  assert.match(dispatchSrc, /readPrefectDeploymentNeutralValidation/);
  assert.match(dispatchSrc, /trigger_neutral_validation_deployment/);
});

test("workflow settings expose neutral validation knobs", () => {
  assert.match(settingsSrc, /neutral_validation_batch_enabled/);
  assert.match(settingsSrc, /neutral_validation_min_abs_mean_rank_ic/);
  assert.match(settingsSrc, /getNeutralValidationKey/);
  assert.match(settingsSrc, /defaultString: "auto"/);
});

test("select-neutralization supports AI exposures config", () => {
  const selectSrc = readFileSync(
    path.join(root, "workers/factor-ideas/src/select-neutralization.js"),
    "utf8"
  );
  assert.match(selectSrc, /resolveNeutralizationForJob/);
  assert.match(selectSrc, /DEFAULT_NEUTRALIZATION_SPEC/);
  assert.match(selectSrc, /NEUTRALIZATION_SELECTION/);
});

test("engine neutralization_spec module is generic", () => {
  const engineSrc = readFileSync(
    path.join(root, "scripts/neutralization_spec.py"),
    "utf8"
  );
  assert.match(engineSrc, /sequential_ols/);
  assert.match(engineSrc, /ALLOWED_FIELDS/);
  assert.match(engineSrc, /build_neutralization_cte_sql/);
});
