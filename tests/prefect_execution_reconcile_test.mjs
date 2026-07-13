function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function mapPrefectApiState(flowRun) {
  const stateType = String(
    flowRun?.state_type ?? flowRun?.state?.type ?? ""
  )
    .trim()
    .toUpperCase();
  if (stateType === "COMPLETED") {
    return "completed";
  }
  if (["FAILED", "CRASHED", "CANCELLED", "CANCELED"].includes(stateType)) {
    return "failed";
  }
  if (stateType === "RUNNING") {
    return "running";
  }
  if (stateType === "PENDING") {
    return "pending";
  }
  return "scheduled";
}

assert(mapPrefectApiState({ state_type: "COMPLETED" }) === "completed");
assert(mapPrefectApiState({ state: { type: "FAILED" } }) === "failed");
assert(mapPrefectApiState({ state_type: "RUNNING" }) === "running");
assert(mapPrefectApiState({ state_type: "SCHEDULED" }) === "scheduled");

console.log("prefect_execution_reconcile_test.mjs OK");
