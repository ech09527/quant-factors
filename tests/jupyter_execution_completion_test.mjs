import {
  mapBusinessStatusToExecutionStatus,
  markerResultToReportItems
} from "../workers/factor-ideas/src/jupyter-execution-completion.js";
import { parseJupyterResultMarker } from "../workers/factor-ideas/src/jupyter-websocket-monitor.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const marker = "__QF_FACTOR_VALIDATION_JSON__";
const stream = `noise\n${marker}{"results":[{"task_id":1,"factor_validation_id":2,"status":"success","evaluation":{"factor_sql":{"sql":"select 1"},"diagnostics":{"stage":"eval"}},"mlflow":{"mlflow_run_id":"run-1"}}]}`;
const parsed = parseJupyterResultMarker(stream);
assert(parsed?.marker === marker, "marker detected");
assert(Array.isArray(parsed?.parsed?.results), "results parsed");

const job = {
  task_id: 1,
  factor_validation_id: 2,
  factor_sql: { sql: "fallback" }
};
const items = markerResultToReportItems("factor_validation", job, parsed.parsed);
assert(items.length === 1, "one report item");
assert(items[0].task_id === 1, "task_id mapped");
assert(items[0].factor_validation_id === 2, "factor_validation_id mapped");
assert(items[0].status === "success", "status mapped");
assert(items[0].mlflow_run_id === "run-1", "mlflow run id mapped");

assert(mapBusinessStatusToExecutionStatus("success") === "succeeded", "success -> succeeded");
assert(mapBusinessStatusToExecutionStatus("failed") === "failed", "failed preserved");
assert(mapBusinessStatusToExecutionStatus("skipped") === "skipped", "skipped preserved");

console.log("jupyter_execution_completion_test: ok");
