const MIN_VIEW_DAYS = 7;

function formatMetric(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(4);
}

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

function computeYScale(values, paddingRatio = 0.08) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) {
    return { min: -0.01, max: 0.01 };
  }
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.2, 0.001);
    min -= pad;
    max += pad;
  } else {
    const span = max - min;
    min -= span * paddingRatio;
    max += span * paddingRatio;
  }
  return { min, max };
}

function clampView(start, end, total, minSpan = MIN_VIEW_DAYS) {
  const maxIdx = Math.max(0, total - 1);
  const span = Math.max(minSpan, end - start + 1);
  let nextStart = Math.max(0, Math.min(start, maxIdx));
  let nextEnd = Math.min(maxIdx, nextStart + span - 1);
  nextStart = Math.max(0, nextEnd - span + 1);
  return { start: nextStart, end: nextEnd };
}

function indexAtRatio(ratio, start, end) {
  const span = Math.max(1, end - start);
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.min(end, Math.max(start, start + Math.round(clamped * span)));
}

function clientXToRatio(clientX, rect, paddingLeft, plotWidth) {
  return (clientX - rect.left - paddingLeft) / plotWidth;
}

function globalIndexFromRatio(ratio, total) {
  if (total <= 1) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.min(total - 1, Math.round(clamped * (total - 1)));
}

export function mountIcSeriesChart(container, series) {
  const points = Array.isArray(series?.points) ? series.points : [];
  container.innerHTML = "";
  if (!points.length) {
    container.innerHTML = `<p class="muted">暂无 IC 序列数据。</p>`;
    return () => {};
  }

  const total = points.length;
  let viewStart = 0;
  let viewEnd = total - 1;

  const toolbar = document.createElement("div");
  toolbar.className = "ic-series-chart-toolbar";
  const rangeText = document.createElement("span");
  rangeText.className = "ic-series-chart-range";
  const actions = document.createElement("div");
  actions.className = "ic-series-chart-actions";
  actions.innerHTML = `
    <sl-button size="small" data-action="zoom-in">放大</sl-button>
    <sl-button size="small" data-action="zoom-out">缩小</sl-button>
    <sl-button size="small" data-action="reset-range">重置范围</sl-button>
  `;
  toolbar.appendChild(rangeText);
  toolbar.appendChild(actions);
  container.appendChild(toolbar);

  const meta = document.createElement("p");
  meta.className = "muted ic-series-chart-meta";
  meta.textContent = "主图悬浮查看数值 · 滚轮缩放 · 下方滑块拖拽日期范围";
  container.appendChild(meta);

  const wrap = document.createElement("div");
  wrap.className = "ic-series-chart-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "ic-series-chart-canvas";
  const tooltip = document.createElement("div");
  tooltip.className = "ic-series-chart-tooltip hidden";
  wrap.appendChild(canvas);
  wrap.appendChild(tooltip);
  container.appendChild(wrap);

  const brushWrap = document.createElement("div");
  brushWrap.className = "ic-series-chart-brush-wrap";
  const brushCanvas = document.createElement("canvas");
  brushCanvas.className = "ic-series-chart-brush";
  brushWrap.appendChild(brushCanvas);
  container.appendChild(brushWrap);

  const legend = document.createElement("div");
  legend.className = "ic-series-chart-legend";
  legend.innerHTML = `
    <span><i class="ic-series-swatch ic"></i>IC</span>
    <span><i class="ic-series-swatch rank-ic"></i>Rank IC</span>
  `;
  container.appendChild(legend);

  const width = Math.max(320, container.clientWidth || 720);
  const mainHeight = 280;
  const brushHeight = 52;
  const padding = { top: 16, right: 16, bottom: 28, left: 52 };
  const brushPadding = { top: 8, right: 16, bottom: 8, left: 52 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = mainHeight - padding.top - padding.bottom;
  const brushPlotWidth = width - brushPadding.left - brushPadding.right;
  const brushPlotHeight = brushHeight - brushPadding.top - brushPadding.bottom;

  const icValues = points.map((point) => point.mean_ic);
  const rankValues = points.map((point) => point.mean_rank_ic);
  const globalYScale = computeYScale([...icValues, ...rankValues]);

  const disposers = [];
  let brushDrag = null;
  let activeIndex = -1;

  const visiblePoints = () => points.slice(viewStart, viewEnd + 1);
  const visibleIc = () => icValues.slice(viewStart, viewEnd + 1);
  const visibleRank = () => rankValues.slice(viewStart, viewEnd + 1);

  const updateRangeText = () => {
    const startDay = points[viewStart]?.day ?? "-";
    const endDay = points[viewEnd]?.day ?? "-";
    const days = viewEnd - viewStart + 1;
    rangeText.textContent = `${startDay} ~ ${endDay} · ${days} 天`;
  };

  const mainXAt = (localIndex, count) =>
    padding.left + (count <= 1 ? plotWidth / 2 : (localIndex / (count - 1)) * plotWidth);

  const yAt = (value, yScale) => {
    if (!Number.isFinite(value)) {
      return null;
    }
    const ratio = (value - yScale.min) / (yScale.max - yScale.min);
    return padding.top + (1 - ratio) * plotHeight;
  };

  const brushXAt = (globalIndex) =>
    brushPadding.left +
    (total <= 1 ? brushPlotWidth / 2 : (globalIndex / (total - 1)) * brushPlotWidth);

  const drawMain = () => {
    const count = viewEnd - viewStart + 1;
    const yScale = computeYScale([...visibleIc(), ...visibleRank()]);
    const ctx = resizeCanvas(canvas, width, mainHeight);
    ctx.clearRect(0, 0, width, mainHeight);

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "11px IBM Plex Mono, monospace";
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i += 1) {
      const y = padding.top + (plotHeight / gridLines) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      const value = yScale.max - ((yScale.max - yScale.min) / gridLines) * i;
      ctx.fillText(value.toFixed(3), 8, y + 4);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, mainHeight - padding.bottom);
    ctx.lineTo(width - padding.right, mainHeight - padding.bottom);
    ctx.stroke();

    const drawLine = (values, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      values.forEach((value, index) => {
        const y = yAt(value, yScale);
        if (y == null) {
          started = false;
          return;
        }
        const x = mainXAt(index, count);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    };

    drawLine(visibleIc(), "#5b9cff");
    drawLine(visibleRank(), "#f0a05a");

    if (activeIndex >= viewStart && activeIndex <= viewEnd) {
      const localIndex = activeIndex - viewStart;
      const x = mainXAt(localIndex, count);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, mainHeight - padding.bottom);
      ctx.stroke();

      const point = points[activeIndex];
      const markers = [
        { value: point.mean_ic, color: "#5b9cff" },
        { value: point.mean_rank_ic, color: "#f0a05a" }
      ];
      for (const marker of markers) {
        const y = yAt(marker.value, yScale);
        if (y == null) continue;
        ctx.fillStyle = marker.color;
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  const drawBrush = () => {
    const ctx = resizeCanvas(brushCanvas, width, brushHeight);
    ctx.clearRect(0, 0, width, brushHeight);

    const yAtGlobal = (value) => {
      if (!Number.isFinite(value)) return null;
      const ratio = (value - globalYScale.min) / (globalYScale.max - globalYScale.min);
      return brushPadding.top + (1 - ratio) * brushPlotHeight;
    };

    ctx.strokeStyle = "rgba(91, 156, 255, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    icValues.forEach((value, index) => {
      const y = yAtGlobal(value);
      if (y == null) {
        started = false;
        return;
      }
      const x = brushXAt(index);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    const x0 = brushXAt(viewStart);
    const x1 = brushXAt(viewEnd);
    const top = brushPadding.top;
    const bottom = brushHeight - brushPadding.bottom;

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(brushPadding.left, top, Math.max(0, x0 - brushPadding.left), brushPlotHeight);
    ctx.fillRect(x1, top, Math.max(0, width - brushPadding.right - x1), brushPlotHeight);

    ctx.fillStyle = "rgba(91, 156, 255, 0.18)";
    ctx.fillRect(x0, top, Math.max(2, x1 - x0), brushPlotHeight);

    ctx.strokeStyle = "rgba(91, 156, 255, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, top, Math.max(2, x1 - x0), brushPlotHeight);

    const handleWidth = 6;
    ctx.fillStyle = "#5b9cff";
    ctx.fillRect(x0 - handleWidth / 2, top, handleWidth, brushPlotHeight);
    ctx.fillRect(x1 - handleWidth / 2, top, handleWidth, brushPlotHeight);
  };

  const redraw = () => {
    updateRangeText();
    drawMain();
    drawBrush();
  };

  const showTooltip = (index, clientX, clientY) => {
    const point = points[index];
    if (!point) {
      tooltip.classList.add("hidden");
      return;
    }
    tooltip.innerHTML = `
      <div><strong>${point.day}</strong></div>
      <div>IC: ${formatMetric(point.mean_ic)}</div>
      <div>Rank IC: ${formatMetric(point.mean_rank_ic)}</div>
      <div class="muted">期内样本: ${point.n_periods ?? "-"}</div>
    `;
    tooltip.classList.remove("hidden");
    const bounds = wrap.getBoundingClientRect();
    const left = Math.min(Math.max(clientX - bounds.left + 12, 8), width - 168);
    const top = Math.max(clientY - bounds.top - 72, 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const setView = (start, end) => {
    const next = clampView(start, end, total);
    viewStart = next.start;
    viewEnd = next.end;
    redraw();
  };

  const zoomView = (factor, anchorRatio) => {
    const span = viewEnd - viewStart + 1;
    const nextSpan = Math.max(
      MIN_VIEW_DAYS,
      Math.min(total, Math.round(span * factor))
    );
    const anchorIndex = viewStart + Math.round((viewEnd - viewStart) * anchorRatio);
    const half = Math.floor(nextSpan / 2);
    setView(anchorIndex - half, anchorIndex - half + nextSpan - 1);
  };

  const onMainMove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const ratio = clientXToRatio(event.clientX, rect, padding.left, plotWidth);
    const count = viewEnd - viewStart + 1;
    const localIndex = indexAtRatio(ratio, 0, count - 1);
    activeIndex = viewStart + localIndex;
    drawMain();
    showTooltip(activeIndex, event.clientX, event.clientY);
  };

  const onMainLeave = () => {
    tooltip.classList.add("hidden");
    activeIndex = -1;
    drawMain();
  };

  const onMainWheel = (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const ratio = clientXToRatio(event.clientX, rect, padding.left, plotWidth);
    const factor = event.deltaY < 0 ? 0.8 : 1.25;
    zoomView(factor, ratio);
  };

  const brushModeAt = (clientX) => {
    const rect = brushCanvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const x0 = brushXAt(viewStart);
    const x1 = brushXAt(viewEnd);
    const edge = 8;
    if (Math.abs(x - x0) <= edge) return "start";
    if (Math.abs(x - x1) <= edge) return "end";
    if (x > x0 && x < x1) return "move";
    return "select";
  };

  const onBrushDown = (event) => {
    const mode = brushModeAt(event.clientX);
    brushDrag = {
      mode,
      startViewStart: viewStart,
      startViewEnd: viewEnd,
      startX: event.clientX
    };
    if (mode === "select") {
      const rect = brushCanvas.getBoundingClientRect();
      const ratio = clientXToRatio(event.clientX, rect, brushPadding.left, brushPlotWidth);
      const anchor = globalIndexFromRatio(ratio, total);
      const span = viewEnd - viewStart + 1;
      setView(anchor - Math.floor(span / 2), anchor + Math.ceil(span / 2) - 1);
      brushDrag = {
        mode: "move",
        startViewStart: viewStart,
        startViewEnd: viewEnd,
        startX: event.clientX
      };
    }
    event.preventDefault();
  };

  const onBrushMove = (event) => {
    if (!brushDrag) return;
    const rect = brushCanvas.getBoundingClientRect();
    const deltaRatio = (event.clientX - brushDrag.startX) / brushPlotWidth;
    const deltaIndex = Math.round(deltaRatio * (total - 1));
    const span = brushDrag.startViewEnd - brushDrag.startViewStart + 1;

    if (brushDrag.mode === "start") {
      setView(brushDrag.startViewStart + deltaIndex, brushDrag.startViewEnd);
      return;
    }
    if (brushDrag.mode === "end") {
      setView(brushDrag.startViewStart, brushDrag.startViewEnd + deltaIndex);
      return;
    }
    if (brushDrag.mode === "move") {
      let nextStart = brushDrag.startViewStart + deltaIndex;
      let nextEnd = brushDrag.startViewEnd + deltaIndex;
      if (nextStart < 0) {
        nextEnd -= nextStart;
        nextStart = 0;
      }
      if (nextEnd > total - 1) {
        nextStart -= nextEnd - (total - 1);
        nextEnd = total - 1;
      }
      setView(nextStart, nextEnd);
    }
  };

  const onBrushUp = () => {
    brushDrag = null;
  };

  canvas.addEventListener("mousemove", onMainMove);
  canvas.addEventListener("mouseleave", onMainLeave);
  canvas.addEventListener("wheel", onMainWheel, { passive: false });
  brushCanvas.addEventListener("mousedown", onBrushDown);
  window.addEventListener("mousemove", onBrushMove);
  window.addEventListener("mouseup", onBrushUp);

  disposers.push(() => canvas.removeEventListener("mousemove", onMainMove));
  disposers.push(() => canvas.removeEventListener("mouseleave", onMainLeave));
  disposers.push(() => canvas.removeEventListener("wheel", onMainWheel));
  disposers.push(() => brushCanvas.removeEventListener("mousedown", onBrushDown));
  disposers.push(() => window.removeEventListener("mousemove", onBrushMove));
  disposers.push(() => window.removeEventListener("mouseup", onBrushUp));

  actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.getAttribute("data-action");
    if (action === "zoom-in") {
      zoomView(0.75, 0.5);
      return;
    }
    if (action === "zoom-out") {
      zoomView(1.33, 0.5);
      return;
    }
    if (action === "reset-range") {
      setView(0, total - 1);
    }
  });
  disposers.push(() => actions.replaceWith(actions.cloneNode(true)));

  redraw();

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
