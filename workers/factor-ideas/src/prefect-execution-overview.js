import { prefectExecutionEnabled } from "./prefect-execution-config.js";
import {
  countPrefectFlowRunsByStatus,
  listActivePrefectFlowRuns,
  reclaimStalePrefectFlowRuns
} from "./prefect-execution-db.js";
import { getPrefectWorkPool } from "./prefect-client.js";

export async function getPrefectExecutionOverview(env, options = {}) {
  if (!prefectExecutionEnabled(env)) {
    return { enabled: false, reason: "prefect_execution_disabled" };
  }

  const workPoolName =
    options.workPoolName?.trim() ||
    env.PREFECT_WORK_POOL?.trim() ||
    "quant-factors-eval";

  let workPool = null;
  let workPoolError = null;
  try {
    workPool = await getPrefectWorkPool(env, workPoolName);
  } catch (error) {
    workPoolError = error instanceof Error ? error.message : String(error);
  }

  const statusCounts = await countPrefectFlowRunsByStatus(env.DB);
  const activeRuns = await listActivePrefectFlowRuns(env.DB, null, 200);
  const reclaim = await reclaimStalePrefectFlowRuns(env.DB, env);

  const activeByBusiness = {
    factor_validation: 0
  };
  for (const run of activeRuns) {
    const key = String(run.business_type ?? "");
    if (key in activeByBusiness) {
      activeByBusiness[key] += 1;
    }
  }

  const concurrencyLimit = Number(workPool?.concurrency_limit ?? 0);
  const activeTotal =
    (statusCounts.scheduled ?? 0) +
    (statusCounts.pending ?? 0) +
    (statusCounts.running ?? 0);

  return {
    enabled: true,
    work_pool: {
      name: workPoolName,
      concurrency_limit: concurrencyLimit || null,
      status: workPool?.status ?? null,
      error: workPoolError
    },
    flow_runs: {
      status_counts: statusCounts,
      active_total: activeTotal,
      active_by_business: activeByBusiness,
      recent_active: activeRuns.slice(0, 20)
    },
    reclaim
  };
}
