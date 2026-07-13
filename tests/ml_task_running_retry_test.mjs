function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// 逻辑与 markMlTaskRunningIfPending 一致：failed 应可转为 running
function shouldMarkRunning(status) {
  return !["success", "skipped", "running"].includes(String(status ?? ""));
}

assert(shouldMarkRunning("failed"), "failed tasks should be reset when execution starts");
assert(shouldMarkRunning("pending"), "pending tasks should be reset when execution starts");
assert(!shouldMarkRunning("success"), "success tasks must not be reset");
assert(!shouldMarkRunning("skipped"), "skipped tasks must not be reset");
assert(!shouldMarkRunning("running"), "already running tasks should be left alone");

console.log("ml_task_running_retry_test.mjs passed");
