const BIN_COUNT = 24;

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

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function gaussian(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function interpolateCurveDensity(curve, xValue) {
  if (!curve.length) return null;
  if (xValue <= curve[0].x) return curve[0].y;
  if (xValue >= curve[curve.length - 1].x) return curve[curve.length - 1].y;
  for (let index = 1; index < curve.length; index += 1) {
    const prev = curve[index - 1];
    const next = curve[index];
    if (xValue <= next.x) {
      const span = next.x - prev.x || 1;
      const ratio = (xValue - prev.x) / span;
      return prev.y + (next.y - prev.y) * ratio;
    }
  }
  return curve[curve.length - 1].y;
}

export function pickDensityHover(model, ratio) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const span = model.max - model.min || 1;
  const xValue = model.min + clamped * span;
  const binIndex = Math.min(model.bins.length - 1, Math.max(0, Math.floor(clamped * model.bins.length)));
  const binStart = model.min + binIndex * model.binWidth;
  const binEnd = binStart + model.binWidth;
  const count = model.bins[binIndex] ?? 0;
  const density = count / (model.count * model.binWidth);
  const kdeDensity = interpolateCurveDensity(model.curve, xValue);
  return {
    xValue,
    binIndex,
    binStart,
    binEnd,
    count,
    density,
    kdeDensity,
  };
}

export function computeDensityCurve(values, binCount = BIN_COUNT) {
  const finite = finiteValues(values);
  if (!finite.length) {
    return { bins: [], curve: [], min: 0, max: 0, maxDensity: 0, mean: null, std: 0, count: 0, binWidth: 0 };
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

  const binWidth = span / binCount;
  const normalizedBins = bins.map((count) => count / (finite.length * binWidth));

  const bandwidth =
    1.06 * stdDev(finite) * finite.length ** -0.2 || Math.max(binWidth, 0.001);
  const gridSize = binCount * 4;
  const curve = [];
  for (let index = 0; index <= gridSize; index += 1) {
    const x = min + (span * index) / gridSize;
    let density = 0;
    for (const value of finite) {
      density += gaussian((x - value) / bandwidth);
    }
    density /= finite.length * bandwidth;
    curve.push({ x, y: density });
  }

  const maxDensity = Math.max(...normalizedBins, ...curve.map((point) => point.y), 1e-6);
  return {
    bins,
    curve,
    min,
    max,
    maxDensity,
    mean: mean(finite),
    std: stdDev(finite),
    count: finite.length,
    binWidth,
  };
}

export function mountIcDensityChart(container, values, { title, color, referenceValue = null } = {}) {
  container.innerHTML = "";
  const finite = finiteValues(values);
  if (!finite.length) {
    container.innerHTML = `<p class="muted">暂无密度数据。</p>`;
    return () => {};
  }

  const stats = document.createElement("p");
  stats.className = "muted ic-density-chart-stats";
  container.appendChild(stats);

  const meta = document.createElement("p");
  meta.className = "muted ic-density-chart-meta";
  meta.textContent = "悬浮查看值范围、密度与样本数";
  container.appendChild(meta);

  const wrap = document.createElement("div");
  wrap.className = "ic-density-chart-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "ic-density-chart-canvas";
  const tooltip = document.createElement("div");
  tooltip.className = "ic-density-chart-tooltip hidden";
  wrap.appendChild(canvas);
  wrap.appendChild(tooltip);
  container.appendChild(wrap);

  const layout = {
    width: 640,
    height: 240,
    padding: { top: 18, right: 16, bottom: 32, left: 44 },
  };
  let hover = null;
  let model = computeDensityCurve(finite);

  const plotWidth = () => layout.width - layout.padding.left - layout.padding.right;
  const plotHeight = () => layout.height - layout.padding.top - layout.padding.bottom;
  const xScale = (value) =>
    layout.padding.left + ((value - model.min) / (model.max - model.min || 1)) * plotWidth();
  const yScale = (value) =>
    layout.padding.top + plotHeight() - (value / model.maxDensity) * plotHeight();

  const render = () => {
    layout.width = Math.max(320, container.clientWidth || 640);
    model = computeDensityCurve(finite);
    const ctx = resizeCanvas(canvas, layout.width, layout.height);
    ctx.clearRect(0, 0, layout.width, layout.height);

    stats.textContent = `${title} · n=${model.count} · mean=${formatMetric(model.mean)} · std=${formatMetric(model.std)}`;

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.moveTo(layout.padding.left, layout.padding.top);
    ctx.lineTo(layout.padding.left, layout.padding.top + plotHeight());
    ctx.lineTo(layout.padding.left + plotWidth(), layout.padding.top + plotHeight());
    ctx.stroke();

    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(model.min.toFixed(4), layout.padding.left, layout.height - 10);
    const maxLabel = model.max.toFixed(4);
    ctx.fillText(maxLabel, layout.padding.left + plotWidth() - ctx.measureText(maxLabel).width, layout.height - 10);

    const barWidth = plotWidth() / model.bins.length;
    model.bins.forEach((count, index) => {
      if (!count) return;
      const density = count / (model.count * model.binWidth);
      const barHeight = (density / model.maxDensity) * plotHeight();
      const x = layout.padding.left + index * barWidth;
      const y = layout.padding.top + plotHeight() - barHeight;
      const active = hover?.binIndex === index;
      ctx.fillStyle = active ? `${color}66` : `${color}33`;
      ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
    });

    ctx.beginPath();
    model.curve.forEach((point, index) => {
      const x = xScale(point.x);
      const y = yScale(point.y);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    const ref = Number(referenceValue);
    if (Number.isFinite(ref) && ref >= model.min && ref <= model.max) {
      const refX = xScale(ref);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(refX, layout.padding.top);
      ctx.lineTo(refX, layout.padding.top + plotHeight());
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (hover) {
      const crossX = xScale(hover.xValue);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(crossX, layout.padding.top);
      ctx.lineTo(crossX, layout.padding.top + plotHeight());
      ctx.stroke();

      const kdeY = yScale(hover.kdeDensity);
      if (Number.isFinite(kdeY)) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(crossX, kdeY, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const showTooltip = (pick, clientX, clientY) => {
    if (!pick) {
      tooltip.classList.add("hidden");
      return;
    }
    const pct = model.count > 0 ? ((pick.count / model.count) * 100).toFixed(1) : "0.0";
    tooltip.innerHTML = `
      <div><strong>值范围</strong> ${formatMetric(pick.binStart)} ~ ${formatMetric(pick.binEnd)}</div>
      <div>位置 x: ${formatMetric(pick.xValue)}</div>
      <div>柱密度: ${formatMetric(pick.density)}</div>
      <div>曲线密度: ${formatMetric(pick.kdeDensity)}</div>
      <div class="muted">样本 ${pick.count} · ${pct}%</div>
    `;
    tooltip.classList.remove("hidden");
    const bounds = wrap.getBoundingClientRect();
    const left = Math.min(Math.max(clientX - bounds.left + 12, 8), layout.width - 190);
    const top = Math.max(clientY - bounds.top - 96, 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const pickFromEvent = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < layout.padding.left || x > layout.padding.left + plotWidth()) {
      return null;
    }
    const ratio = (x - layout.padding.left) / plotWidth();
    return pickDensityHover(model, ratio);
  };

  const onMove = (event) => {
    const pick = pickFromEvent(event);
    hover = pick;
    render();
    showTooltip(pick, event.clientX, event.clientY);
  };

  const onLeave = () => {
    hover = null;
    render();
    tooltip.classList.add("hidden");
  };

  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);

  render();
  const onResize = () => render();
  window.addEventListener("resize", onResize);
  return () => {
    canvas.removeEventListener("mousemove", onMove);
    canvas.removeEventListener("mouseleave", onLeave);
    window.removeEventListener("resize", onResize);
  };
}

function formatMetric(value) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return Number(value.toFixed(4));
}
