const AUTH_STORAGE_KEY = "qf_auth_token";

export type EmbedParams = {
  embed: boolean;
  token: string | null;
  apiBase: string;
};

export function readEmbedParams(search = window.location.search): EmbedParams {
  const params = new URLSearchParams(search);
  const embed =
    params.get("embed") === "1" ||
    params.get("embed") === "true" ||
    window.self !== window.top;
  const tokenFromQuery = params.get("token")?.trim() || null;
  const apiBase = (params.get("api") || "").trim().replace(/\/$/, "");
  return { embed, token: tokenFromQuery, apiBase };
}

export function resolveAuthToken(explicit?: string | null): string | null {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY);
    if (stored?.trim()) {
      return stored.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

export function persistAuthToken(token: string) {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, token);
  } catch {
    // ignore
  }
}

/** 父页面可通过 postMessage 注入 token（跨系统嵌入） */
export function listenParentAuth(onToken: (token: string) => void): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.type === "qf-auth" && typeof data.token === "string" && data.token.trim()) {
      const token = data.token.trim();
      persistAuthToken(token);
      onToken(token);
    }
  };
  window.addEventListener("message", handler);
  // 告知父页面已就绪，可下发 token
  try {
    window.parent?.postMessage({ type: "qf-research-chat-ready" }, "*");
  } catch {
    // ignore
  }
  return () => window.removeEventListener("message", handler);
}

export function notifyParent(event: { type: string; [key: string]: unknown }) {
  try {
    window.parent?.postMessage(event, "*");
  } catch {
    // ignore
  }
}
