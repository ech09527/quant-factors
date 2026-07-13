export const EXEC_RESULT_MARKER = "__QF_EXEC_RESULT__";

export const JUPYTER_RESULT_MARKERS = [
  "__QF_FACTOR_VALIDATION_JSON__",
  "__QF_EVAL_JSON__",
  EXEC_RESULT_MARKER
];

function parseJsonObjectAfterIndex(text, startIndex) {
  const braceStart = text.indexOf("{", startIndex);
  if (braceStart < 0) {
    return null;
  }
  let depth = 0;
  for (let i = braceStart; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(braceStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function parseJupyterResultMarker(stream) {
  if (typeof stream !== "string" || !stream) {
    return null;
  }

  let bestIndex = -1;
  let bestMarker = null;
  for (const marker of JUPYTER_RESULT_MARKERS) {
    const index = stream.indexOf(marker);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index;
      bestMarker = marker;
    }
  }
  if (bestMarker == null) {
    return null;
  }

  const parsed = parseJsonObjectAfterIndex(stream, bestIndex + bestMarker.length);
  if (parsed == null) {
    return null;
  }
  return { marker: bestMarker, parsed };
}

export function parseJupyterChannelMessage(raw) {
  if (typeof raw !== "string" || !raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function collectJupyterExecuteMessage(msg, msgId, acc) {
  const parent = String(msg?.parent_header?.msg_id ?? "");
  if (parent !== String(msgId)) {
    return acc;
  }

  const msgType = String(msg?.header?.msg_type ?? "");
  if (msgType === "stream") {
    acc.stream += String(msg?.content?.text ?? "");
  } else if (msgType === "error") {
    const traceback = msg?.content?.traceback;
    acc.error = Array.isArray(traceback)
      ? traceback.join("\n")
      : String(msg?.content?.evalue ?? "kernel execution error");
    acc.failed = true;
  } else if (msgType === "execute_result") {
    const text = msg?.content?.data?.["text/plain"];
    if (text != null) {
      acc.stream += String(text);
    }
  } else if (msgType === "status" && msg?.content?.execution_state === "idle") {
    acc.idle = true;
  }

  acc.hasResultMarker = JUPYTER_RESULT_MARKERS.some((marker) => acc.stream.includes(marker));
  return acc;
}

export function monitorJupyterWebSocket(webSocket, msgId, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const acc = {
      stream: "",
      error: null,
      failed: false,
      idle: false,
      hasResultMarker: false
    };
    let settled = false;

    const finish = (outcome, extra = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        webSocket.close(1000, "monitor_done");
      } catch {
        // ignore close errors
      }
      resolve({
        outcome,
        stream: acc.stream,
        error: acc.error,
        failed: acc.failed,
        idle: acc.idle,
        hasResultMarker: acc.hasResultMarker,
        ...extra
      });
    };

    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    webSocket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      const msg = parseJupyterChannelMessage(raw);
      if (!msg) {
        return;
      }
      collectJupyterExecuteMessage(msg, msgId, acc);
      if (acc.failed) {
        finish("error");
      } else if (acc.idle) {
        finish("idle");
      }
    });

    webSocket.addEventListener("error", () => finish("ws_error"));
    webSocket.addEventListener("close", () => finish("ws_closed"));
  });
}
