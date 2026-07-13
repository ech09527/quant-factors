import { prefectExecutionEnabled, parseDeploymentName } from "../workers/factor-ideas/src/prefect-execution-config.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(prefectExecutionEnabled({ EXECUTION_BACKEND: "prefect" }) === true);
assert(prefectExecutionEnabled({ EXECUTION_BACKEND: "jupyter" }) === false);
assert(prefectExecutionEnabled({ PREFECT_EXECUTION_ENABLED: "1" }) === true);
assert(prefectExecutionEnabled({}) === false);

const parsed = parseDeploymentName("factor-validation/production");
assert(parsed.flowName === "factor-validation");
assert(parsed.deploymentName === "production");

console.log("prefect_execution_config_test.mjs OK");
