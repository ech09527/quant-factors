import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const factorDb = readFileSync(
  join(root, "workers/factor-ideas/src/factor-validation-db.js"),
  "utf8"
);
const dispatch = readFileSync(
  join(root, "workers/factor-ideas/src/prefect-execution-dispatch.js"),
  "utf8"
);

assert(
  factorDb.includes("export async function markFactorValidationRunningAfterPrefect"),
  "factor validation prefect mark helper missing"
);
{
  const start = factorDb.indexOf("export async function markFactorValidationRunningAfterPrefect");
  const end = factorDb.indexOf("export function buildFactorValidationPrefectJobPayload");
  const block = factorDb.slice(start, end);
  assert(block.includes("AND status = 'pending'"), "mark must only allow pending -> running");
  assert(
    !block.includes("status IN ('pending', 'failed')"),
    "mark must not reset failed tasks back to running"
  );
}
assert(
  factorDb.includes("SET status = 'pending'"),
  "reserveFactorValidationJobsForPrefect should normalize failed retries to pending"
);
{
  const loopStart = dispatch.indexOf("for (const job of jobs)");
  const loopBlock = dispatch.slice(loopStart);
  assert(
    loopBlock.indexOf("markFactorValidationRunningAfterPrefect") <
      loopBlock.indexOf("createPrefectFlowRun"),
    "dispatch must mark running before creating Prefect flow run"
  );
}
assert(
  dispatch.includes("reconcilePrefectFlowRunsFromApi"),
  "dispatch should reconcile Prefect API state before submitting"
);
assert(
  dispatch.includes("revertMlTaskPrefectDispatchToPending"),
  "dispatch should revert running task when flow creation fails"
);
assert(
  dispatch.includes("mlflow_config: mlflowFlow.mlflow_config"),
  "dispatch should pass Worker MLflow config into Prefect flow parameters"
);
assert(
  dispatch.includes("skip_mlflow: mlflowFlow.skip_mlflow"),
  "dispatch should derive skip_mlflow from Worker MLflow config"
);

console.log("prefect_dispatch_semantics_test.mjs OK");
