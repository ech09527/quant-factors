function readMlflowCredentials(env) {
  const trackingUri = (
    env.MLFLOW_TRACKING_URI?.trim() ||
    env.MLFLOW_TRACKING_URL?.trim() ||
    ""
  ).replace(/\/$/, "");
  const username = (
    env.MLFLOW_TRACKING_USERNAME?.trim() ||
    env.DAGSHUB_USER?.trim() ||
    ""
  );
  const password = (
    env.MLFLOW_TRACKING_PASSWORD?.trim() ||
    env.DAGSHUB_TOKEN?.trim() ||
    ""
  );
  return { trackingUri, username, password };
}

function parseJsonObject(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function dayKeyFromPeriod(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  let ms = NaN;
  if (/^\d+$/.test(text)) {
    ms = Number(text);
    if (ms < 1e12) {
      ms *= 1000;
    }
  } else {
    ms = Date.parse(text);
  }
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function mean(values) {
  if (!values.length) {
    return null;
  }
  const sum = values.reduce((acc, item) => acc + item, 0);
  return sum / values.length;
}

export function aggregateIcSeriesDaily(icSeries) {
  const points = Array.isArray(icSeries?.points) ? icSeries.points : [];
  const buckets = new Map();

  for (const point of points) {
    const day = dayKeyFromPeriod(point?.t);
    if (!day) {
      continue;
    }
    let bucket = buckets.get(day);
    if (!bucket) {
      bucket = { ic: [], rank_ic: [], n_periods: 0 };
      buckets.set(day, bucket);
    }
    const ic = Number(point?.ic);
    const rankIc = Number(point?.rank_ic);
    if (Number.isFinite(ic)) {
      bucket.ic.push(ic);
    }
    if (Number.isFinite(rankIc)) {
      bucket.rank_ic.push(rankIc);
    }
    bucket.n_periods += 1;
  }

  const daily = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, bucket]) => ({
      day,
      mean_ic: mean(bucket.ic),
      mean_rank_ic: mean(bucket.rank_ic),
      n_periods: bucket.n_periods
    }));

  return {
    period_axis: icSeries?.period_axis ?? "open_time",
    bucket: "1d",
    source_points: points.length,
    n_days: daily.length,
    range:
      daily.length > 0
        ? { start: daily[0].day, end: daily[daily.length - 1].day }
        : null,
    points: daily
  };
}

async function fetchArtifactText(env, runId, artifactPath) {
  const { trackingUri, username, password } = readMlflowCredentials(env);
  if (!trackingUri || !username || !password) {
    throw new Error("缺少 MLflow 代理凭证（MLFLOW_TRACKING_URI/USERNAME/PASSWORD）");
  }
  const auth = btoa(`${username}:${password}`);
  const urls = [
    `${trackingUri}/get-artifact?path=${encodeURIComponent(artifactPath)}&run_uuid=${encodeURIComponent(runId)}`,
    `${trackingUri}/api/2.0/mlflow-artifacts/get?path=${encodeURIComponent(artifactPath)}&run_id=${encodeURIComponent(runId)}`
  ];

  let lastError = "artifact fetch failed";
  for (const url of urls) {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` }
    });
    if (response.ok) {
      return response.text();
    }
    lastError = `MLflow artifact ${response.status}: ${(await response.text()).slice(0, 200)}`;
  }
  throw new Error(lastError);
}

async function loadIcSeriesFromMlflow(env, runId) {
  const raw = await fetchArtifactText(env, runId, "ic_series.json");
  const parsed = parseJsonObject(raw);
  if (parsed && Array.isArray(parsed.points)) {
    return parsed;
  }

  const evaluationRaw = await fetchArtifactText(env, runId, "evaluation.json");
  const evaluation = parseJsonObject(evaluationRaw);
  const icSeries = evaluation?.ic_series;
  if (icSeries && Array.isArray(icSeries.points)) {
    return icSeries;
  }
  throw new Error("未在 MLflow artifact 中找到 ic_series");
}

export async function getMlflowIcSeriesDaily(env, runId) {
  const icSeries = await loadIcSeriesFromMlflow(env, runId);
  return aggregateIcSeriesDaily(icSeries);
}
