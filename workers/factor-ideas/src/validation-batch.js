import { buildAsyncEvalCode } from "./eval-kernel-builder.js";
import { JupyterWorkerClient, selectWorkerJupyterServer } from "./jupyter-async.js";
import { translateIdeaToFactorSql } from "./translate-idea.js";
import {
  claimValidationWorkflowJobs,
  listEnabledJupyterServers,
  listPendingValidationWorkflowJobs,
  markJupyterServerUsed,
  mergeClaimedJobs,
  reportValidationWorkflowResults,
  updateValidationDiagnostics
} from "./validation-db.js";

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function readReportConfig(env, runtimeConfig) {
  const apiBaseUrl = (
    runtimeConfig?.report_api_base_url ||
    env.FACTOR_API_BASE_URL?.trim() ||
    env.VALIDATION_API_BASE_URL?.trim() ||
    ""
  ).replace(/\/$/, "");
  const apiToken = env.AUTH_PASSWORD?.trim() || env.FACTOR_API_TOKEN?.trim() || "";
  if (!apiBaseUrl || !apiToken) {
    throw new Error("缺少 FACTOR_API_BASE_URL 或 AUTH_PASSWORD（report 回调凭证）");
  }
  return { api_base_url: apiBaseUrl, api_token: apiToken };
}

function validationEnabled(env) {
  const flag = env.VALIDATION_BATCH_ENABLED?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") {
    return false;
  }
  return true;
}

function buildIdeaForTranslation(job) {
  return {
    title: job.title,
    title_hash: job.title_hash,
    hypothesis: job.hypothesis,
    formula_sketch: job.formula_sketch,
    expected_signal: job.expected_signal,
    data_sources: job.data_sources
  };
}

function buildIdeaForEval(job) {
  return {
    title: job.title,
    title_hash: job.title_hash,
    formula_sketch: job.formula_sketch,
    data_sources: job.data_sources
  };
}

export async function runValidationBatch(env) {
  if (!validationEnabled(env)) {
    return { skipped: true, reason: "VALIDATION_BATCH_ENABLED is off" };
  }

  const limit = parsePositiveInt(env.VALIDATION_BATCH_LIMIT, 3, 20);
  const sampleStart = env.SAMPLE_START?.trim() || "2023-01-01";
  const preferredServerKey = env.VALIDATION_JUPYTER_SERVER_KEY?.trim() || "lynas-pub";

  const pending = await listPendingValidationWorkflowJobs(env.DB, limit);
  if (pending.items.length === 0) {
    return { claimed: 0, submitted: 0, failed: 0, errors: [] };
  }

  const claimPayload = pending.items.map((job) => ({
    idea_id: job.idea_id,
    profile_key: job.profile_key
  }));
  const claimResult = await claimValidationWorkflowJobs(env.DB, claimPayload);
  const jobs = mergeClaimedJobs(pending.items, claimResult.jobs);
  if (jobs.length === 0) {
    return { claimed: 0, submitted: 0, failed: 0, errors: [] };
  }

  const servers = await listEnabledJupyterServers(env.DB);
  const { server, fallbackFrom } = selectWorkerJupyterServer(servers, preferredServerKey);
  const jupyter = new JupyterWorkerClient(server);
  const runtimeConfig = server.runtime_config ?? { target_file: "futures/um/klines/1h.parquet" };
  const reportConfig = readReportConfig(env, runtimeConfig);

  const factorSqlCache = new Map();
  const translationErrors = new Map();
  const errors = [];
  let submitted = 0;
  let failed = 0;

  for (const job of jobs) {
    const validationId = Number(job.validation_id);
    const ideaId = Number(job.idea_id);
    const profileKey = String(job.profile_key);

    let factorSql = factorSqlCache.get(ideaId);
    if (factorSql == null && !translationErrors.has(ideaId)) {
      try {
        factorSql = await translateIdeaToFactorSql(
          env,
          buildIdeaForTranslation(job),
          profileKey
        );
        factorSqlCache.set(ideaId, factorSql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        translationErrors.set(ideaId, `翻译失败: ${message}`);
      }
    }

    if (translationErrors.has(ideaId)) {
      const message = translationErrors.get(ideaId);
      await reportValidationWorkflowResults(env.DB, [
        {
          validation_id: validationId,
          status: "failed",
          factor_sql: null,
          metrics: null,
          diagnostics: { error: message, stage: "translation" },
          error_reason: message
        }
      ]);
      failed += 1;
      errors.push({ validation_id: validationId, error: message });
      continue;
    }

    const evalJob = {
      validation_id: validationId,
      idea: buildIdeaForEval(job),
      factor_sql: factorSql,
      profile_key: profileKey,
      validation_profile_key: profileKey,
      label_kind: job.label_kind,
      horizon_bars: job.horizon_bars
    };

    const payload = {
      sample_start: sampleStart,
      jobs: [evalJob],
      runtime_config: runtimeConfig
    };

    try {
      const code = buildAsyncEvalCode(payload, reportConfig);
      const submitInfo = await jupyter.submitExecuteAsync(code);
      const submittedAt = new Date().toISOString();
      await updateValidationDiagnostics(env.DB, validationId, {
        async: true,
        stage: "jupyter_submitted",
        jupyter_server_key: server.key,
        ...(fallbackFrom
          ? { jupyter_server_fallback_from: fallbackFrom, jupyter_server_fallback_reason: "disabled_or_unavailable" }
          : {}),
        kernel_id: submitInfo.kernel_id,
        session_id: submitInfo.session_id,
        msg_id: submitInfo.msg_id,
        submitted_at: submittedAt
      });
      submitted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reportValidationWorkflowResults(env.DB, [
        {
          validation_id: validationId,
          status: "failed",
          factor_sql: factorSql,
          metrics: null,
          diagnostics: { error: message, stage: "jupyter_submit" },
          error_reason: message
        }
      ]);
      failed += 1;
      errors.push({ validation_id: validationId, error: message });
    }
  }

  if (submitted > 0) {
    await markJupyterServerUsed(env.DB, server.key);
  }

  return {
    claimed: jobs.length,
    submitted,
    failed,
    jupyter_server_key: server.key,
    jupyter_server_fallback_from: fallbackFrom,
    errors
  };
}
