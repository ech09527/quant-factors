const BIN_COUNT = 16;

function resizeCanvas(canvas, width, height) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

function finiteValues(values) {
  return values.filter((value) => Number.isFinite(value));
}

function computeBins(values, binCount = BIN_COUNT) {
  const finite = finiteValues(values);
  if (!finite.length) {
    return { bins: [], min: 0, max: 0, maxCount: 0 };
  }
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.25, 0.001);
    min -= pad;
    max += pad;
  }
  const span = max - min || 1;
  const bins = Array.from({ length: binCount }, () => 0);
  for (const value of finite) {
    const ratio = (value - min) / span;
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(ratio * binCount)));
    bins[index] += 1;
  }
  return { bins, min, max, maxCount: Math.max(...bins, 1) };
}

function drawHistogram(canvas, values, { title, color }) {
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 140;
  const ctx = resizeCanvas(canvas, width, height);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 24, right: 12, bottom: 28, left: 36 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const { bins, min, max, maxCount } = computeBins(values);
  const finite = finiteValues(values);

  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(title, padding.left, 16);

  if (!finite.length) {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fillText("暂无数据", padding.left, padding.top + plotHeight / 2);
    return;
  }

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + plotHeight);
  ctx.lineTo(padding.left + plotWidth, padding.top + plotHeight);
  ctx.stroke();

  const barGap = 2;
  const barWidth = plotWidth / bins.length - barGap;
  bins.forEach((count, index) => {
    const barHeight = (count / maxCount) * plotHeight;
    const x = padding.left + index * (barWidth + barGap);
    const y = padding.top + plotHeight - barHeight;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, y, Math.max(1, barWidth), barHeight);
    ctx.globalAlpha = 1;
  });

  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(min.toFixed(4), padding.left, height - 8);
  const maxLabel = max.toFixed(4);
  const maxLabelWidth = ctx.measureText(maxLabel).width;
  ctx.fillText(maxLabel, padding.left + plotWidth - maxLabelWidth, height - 8);
  ctx.fillText(`${finite.length} 条`, padding.left + plotWidth - 52, 16);
}

export function mountMetricSummaryCharts(container, metricsByKey) {
  container.innerHTML = "";
  const cards = [
    { key: "mean_ic", title: "Mean IC 分布", color: "#5b9cff" },
    { key: "mean_rank_ic", title: "Mean Rank IC 分布", color: "#f0a05a" },
  ];

  const disposers = cards.map(({ key, title, color }) => {
    const card = document.createElement("div");
    card.className = "metric-summary-chart-card";
    const canvas = document.createElement("canvas");
    canvas.className = "metric-summary-chart-canvas";
    card.appendChild(canvas);
    container.appendChild(card);

    const values = metricsByKey[key] || [];
    const render = () => drawHistogram(canvas, values, { title, color });
    render();
    const onResize = () => render();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  });

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
    container.innerHTML = "";
  };
}
