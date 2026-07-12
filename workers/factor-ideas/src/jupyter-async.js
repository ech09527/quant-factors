import { monitorJupyterWebSocket } from "./jupyter-websocket-monitor.js";

const WORKFLOW_HTTP_USER_AGENT = "quant-factors-workflow/1.0";

function authHeader(server) {
  const header = String(server.auth_header ?? "Authorization").trim() || "Authorization";
  const scheme = String(server.auth_scheme ?? "token").trim() || "token";
  const token = String(server.auth_token ?? "").trim();
  return { header, value: `${scheme} ${token}` };
}

function kernelChannelsUrl(server, kernelId, sessionId) {
  let base = String(server.ws_base_url ?? "").trim().replace(/\/$/, "");
  if (!base) {
    const parsed = new URL(server.base_url);
    base = `${parsed.protocol}//${parsed.host}`;
  } else if (base.startsWith("wss://")) {
    base = `https://${base.slice("wss://".length)}`;
  } else if (base.startsWith("ws://")) {
    base = `http://${base.slice("ws://".length)}`;
  }
  return `${base}/api/kernels/${kernelId}/channels?session_id=${sessionId}`;
}

export class JupyterWorkerClient {
  constructor(server) {
    this.server = server;
    this.baseUrl = String(server.base_url).trim().replace(/\/$/, "");
    this.xsrfToken = null;
    this.cookies = "";
    this.sessionWarmed = false;
  }

  applySetCookie(response) {
    const raw = response.headers.get("Set-Cookie");
    if (!raw) {
      return;
    }
    const parts = raw.split(/,(?=[^;]+?=)/);
    const jar = new Map();
    if (this.cookies) {
      for (const item of this.cookies.split("; ")) {
        const [name, ...rest] = item.split("=");
        if (name) {
          jar.set(name, rest.join("="));
        }
      }
    }
    for (const part of parts) {
      const segment = part.split(";")[0]?.trim();
      if (!segment) {
        continue;
      }
      const eq = segment.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const name = segment.slice(0, eq).trim();
      const value = segment.slice(eq + 1).trim();
      jar.set(name, value);
      if (name === "_xsrf") {
        this.xsrfToken = value;
      }
    }
    this.cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  buildHeaders(method) {
    const { header, value } = authHeader(this.server);
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": WORKFLOW_HTTP_USER_AGENT,
      [header]: value
    };
    if (this.cookies) {
      headers.Cookie = this.cookies;
    }
    if (method !== "GET" && this.xsrfToken) {
      headers["X-XSRFToken"] = this.xsrfToken;
    }
    return headers;
  }

  async warmupSession() {
    if (this.sessionWarmed) {
      return;
    }
    const response = await fetch(`${this.baseUrl}/api/status`, {
      method: "GET",
      headers: this.buildHeaders("GET")
    });
    this.applySetCookie(response);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Jupyter warmup failed HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    this.sessionWarmed = true;
  }

  async requestJson(path, { method = "GET", body = null } = {}) {
    if (method !== "GET") {
      await this.warmupSession();
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(method),
      body: body == null ? undefined : JSON.stringify(body)
    });
    this.applySetCookie(response);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Jupyter HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async createKernel() {
    const payload = await this.requestJson("/api/kernels", {
      method: "POST",
      body: { name: String(this.server.kernel_name ?? "python3") }
    });
    const kernelId = payload.id;
    if (!kernelId) {
      throw new Error("创建 kernel 失败：缺少 id");
    }
    return String(kernelId);
  }

  async listKernels() {
    const payload = await this.requestJson("/api/kernels");
    return Array.isArray(payload) ? payload : [];
  }

  async shutdownKernel(kernelId) {
    const id = String(kernelId ?? "").trim();
    if (!id) {
      throw new Error("shutdown kernel 失败：缺少 kernel_id");
    }
    await this.requestJson(`/api/kernels/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  }

  async submitExecuteStart(code, { listenTimeoutMs = null } = {}) {
    await this.warmupSession();
    const kernelId = await this.createKernel();
    const sessionId = crypto.randomUUID();
    const msgId = crypto.randomUUID();
    const wsUrl = kernelChannelsUrl(this.server, kernelId, sessionId);
    const { header, value } = authHeader(this.server);
    const wsHeaders = {
      Upgrade: "websocket",
      Connection: "Upgrade",
      [header]: value,
      "User-Agent": WORKFLOW_HTTP_USER_AGENT
    };
    if (this.cookies) {
      wsHeaders.Cookie = this.cookies;
    }
    const response = await fetch(wsUrl, {
      headers: wsHeaders
    });
    if (response.webSocket == null) {
      throw new Error(`Jupyter WebSocket 升级失败 HTTP ${response.status}`);
    }
    const ws = response.webSocket;
    ws.accept();
    const message = {
      header: {
        msg_id: msgId,
        username: "quant-factors",
        session: sessionId,
        msg_type: "execute_request",
        version: "5.3"
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: false,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true
      },
      channel: "shell",
      buffers: []
    };
    ws.send(JSON.stringify(message));
    const monitorPromise =
      listenTimeoutMs == null
        ? null
        : monitorJupyterWebSocket(ws, msgId, { timeoutMs: listenTimeoutMs });
    return {
      kernel_id: kernelId,
      session_id: sessionId,
      msg_id: msgId,
      webSocket: ws,
      monitorPromise
    };
  }

  async submitExecuteAsync(code) {
    const submitInfo = await this.submitExecuteStart(code);
    const ws = submitInfo.webSocket;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      ws.addEventListener(
        "message",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
    });
    ws.close(1000, "submitted");
    return {
      kernel_id: submitInfo.kernel_id,
      session_id: submitInfo.session_id,
      msg_id: submitInfo.msg_id
    };
  }
}

export function readMaxKernels(server) {
  const raw = server?.max_kernels;
  if (raw === 0 || raw === "0") {
    return null;
  }
  const parsed = Number(raw ?? 30);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 30;
  }
  return Math.floor(parsed);
}

export async function getJupyterKernelCapacity(client, server) {
  const limit = readMaxKernels(server);
  if (limit == null) {
    return {
      limited: false,
      current: null,
      limit: null,
      available: null,
      at_limit: false
    };
  }

  const kernels = await client.listKernels();
  const current = kernels.length;
  const available = Math.max(0, limit - current);
  return {
    limited: true,
    current,
    limit,
    available,
    at_limit: current >= limit
  };
}

export function selectWorkerJupyterServer(servers, preferredKey) {
  const enabled = servers.filter((item) => item.enabled !== false);
  const candidates = enabled.filter(
    (item) => !item.proxy_url && item.connect_mode === "kernel_channels"
  );
  if (candidates.length === 0) {
    throw new Error("没有可供 Worker 直连的 jupyter server（需 kernel_channels、已启用且无 proxy）");
  }

  if (preferredKey) {
    const match = candidates.find((item) => item.key === preferredKey);
    if (match) {
      return { server: match, fallbackFrom: null };
    }
    return {
      server: candidates[0],
      fallbackFrom: preferredKey
    };
  }

  return { server: candidates[0], fallbackFrom: null };
}
