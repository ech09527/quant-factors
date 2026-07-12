import { shouldNotifyCoordinatorForReport } from "../workers/factor-ideas/src/factor-validation-api.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  shouldNotifyCoordinatorForReport({
    status: "running",
    diagnostics: { report_phase: "eval" }
  }) === false,
  "eval+running should not notify"
);

assert(
  shouldNotifyCoordinatorForReport({
    status: "success",
    diagnostics: { report_phase: "mlflow" }
  }) === true,
  "mlflow+success should notify"
);

assert(
  shouldNotifyCoordinatorForReport({
    status: "running",
    diagnostics: { report_phase: "mlflow" }
  }) === false,
  "mlflow+running should not notify"
);

assert(
  shouldNotifyCoordinatorForReport({
    status: "failed",
    diagnostics: { report_phase: "eval" }
  }) === true,
  "eval+failed should notify"
);

assert(
  shouldNotifyCoordinatorForReport({
    status: "success",
    diagnostics: { report_phase: "eval" }
  }) === true,
  "eval+success abnormal should notify to release slot"
);

assert(
  shouldNotifyCoordinatorForReport({
    status: "failed",
    diagnostics: { report_phase: "mlflow" }
  }) === true,
  "mlflow+failed should notify"
);

assert(
  shouldNotifyCoordinatorForReport({
    status: "success",
    diagnostics: {}
  }) === true,
  "legacy single-phase success should notify"
);

console.log("factor_validation_report_phases_test.mjs OK");
