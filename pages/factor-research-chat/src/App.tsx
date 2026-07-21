import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  listenParentAuth,
  notifyParent,
  persistAuthToken,
  readEmbedParams,
  resolveAuthToken,
} from "./auth";
import {
  fallbackMarkdownFromTools,
  getMessageText,
  listToolParts,
  shortenErrorMessage,
} from "./messageUtils";

const SUGGESTIONS = [
  "Rank IC 绝对值 > 0.05、neutralization=none、success 的 Top 20",
  "对比 idea 336 一次验证与中性化结果",
];

export default function ChatApp() {
  const embedParams = useMemo(() => readEmbedParams(), []);
  const [token, setToken] = useState<string | null>(() =>
    resolveAuthToken(embedParams.token),
  );
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [input, setInput] = useState("");
  const [showTools, setShowTools] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (embedParams.token) {
      persistAuthToken(embedParams.token);
    }
    return listenParentAuth((next) => setToken(next));
  }, [embedParams.token]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${embedParams.apiBase || ""}/api/factor-research-chat`,
        headers: () => {
          const auth = resolveAuthToken(tokenRef.current);
          const headers: Record<string, string> = {
            "User-Agent": "quant-factors-research-chat/1.0",
            Accept: "text/event-stream",
          };
          if (auth) {
            headers.Authorization = `Bearer ${auth}`;
          }
          return headers;
        },
        fetch: async (url, init) => {
          const response = await fetch(url, init);
          if (!response.ok) {
            const raw = await response.text().catch(() => "");
            let message = raw;
            try {
              const json = JSON.parse(raw) as { error?: string };
              if (json?.error) {
                message = json.error;
              }
            } catch {
              message = shortenErrorMessage(raw || `请求失败 (${response.status})`);
            }
            throw new Error(message || `请求失败 (${response.status})`);
          }
          const streamHeader = response.headers.get("x-vercel-ai-ui-message-stream");
          if (streamHeader !== "v1") {
            throw new Error("服务端未返回 UI Message Stream，请刷新后重试");
          }
          return response;
        },
      }),
    [embedParams.apiBase],
  );

  const { messages, sendMessage, status, error, clearError, setMessages, stop } =
    useChat({
      transport,
      onError: (err) => {
        notifyParent({
          type: "qf-research-chat-error",
          error: shortenErrorMessage(err),
        });
      },
      onFinish: () => {
        notifyParent({ type: "qf-research-chat-finish" });
      },
    });

  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, status]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) {
      return;
    }
    if (!resolveAuthToken(tokenRef.current)) {
      clearError();
      notifyParent({ type: "qf-research-chat-auth-required" });
      return;
    }
    setInput("");
    await sendMessage({ text });
  }

  function onClear() {
    void stop();
    setMessages([]);
    clearError();
  }

  function onIdeaClick(ideaId: string) {
    notifyParent({ type: "qf-open-idea", ideaId: Number(ideaId) });
  }

  return (
    <div className={`app ${embedParams.embed ? "app--embed" : ""}`}>
      {!embedParams.embed && (
        <header className="header">
          <div>
            <h1>因子研究助手</h1>
            <p className="muted">自然语言查询验证结果与因子想法（只读流式）</p>
          </div>
        </header>
      )}

      {!token && (
        <div className="banner banner--warn">
          未检测到鉴权 token。同域可先登录 Dashboard；嵌入时请传{" "}
          <code>?token=</code> 或 postMessage <code>qf-auth</code>。
        </div>
      )}

      <div className="messages" ref={listRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>可以这样问：</p>
            <div className="suggestions">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="chip"
                  onClick={() => setInput(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => {
          const text = getMessageText(message);
          const tools = listToolParts(message);
          const isUser = message.role === "user";
          const displayText =
            text ||
            (!isUser && !busy ? fallbackMarkdownFromTools(message) : "") ||
            (!isUser && busy ? "查询中…" : "");
          return (
            <article
              key={message.id}
              className={`bubble ${isUser ? "bubble--user" : "bubble--assistant"}`}
            >
              <div className="bubble-role">{isUser ? "你" : "助手"}</div>
              {tools.length > 0 && !isUser && (
                <div className="tool-chips">
                  {tools.map((part, index) => {
                    const name = isToolUIPart(part) ? getToolName(part) : "tool";
                    const state = "state" in part ? String(part.state) : "";
                    return (
                      <span key={`${message.id}-tool-${index}`} className="tool-chip">
                        {name}
                        {state === "output-available"
                          ? " ✓"
                          : state === "output-error"
                            ? " ✗"
                            : " …"}
                      </span>
                    );
                  })}
                </div>
              )}
              {isUser ? (
                <div className="bubble-text">{displayText}</div>
              ) : (
                <div className="markdown">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      ),
                      code: ({ children, className }) => {
                        const value = String(children);
                        const ideaMatch = value.match(/^idea[_-]?(\d+)$/i);
                        if (ideaMatch) {
                          return (
                            <button
                              type="button"
                              className="idea-link"
                              onClick={() => onIdeaClick(ideaMatch[1])}
                            >
                              {value}
                            </button>
                          );
                        }
                        return <code className={className}>{children}</code>;
                      },
                    }}
                  >
                    {displayText}
                  </ReactMarkdown>
                </div>
              )}
              {showTools && tools.length > 0 && (
                <details className="tool-trace">
                  <summary>工具调用原始数据 ({tools.length})</summary>
                  <pre>{JSON.stringify(tools, null, 2)}</pre>
                </details>
              )}
            </article>
          );
        })}

        {busy && messages.at(-1)?.role === "user" && (
          <article className="bubble bubble--assistant bubble--pending">
            <div className="bubble-role">助手</div>
            <div className="bubble-text">查询中…</div>
          </article>
        )}
      </div>

      {error && (
        <div className="banner banner--error" role="alert">
          {shortenErrorMessage(error)}
          <button type="button" className="linkish" onClick={() => clearError()}>
            关闭
          </button>
        </div>
      )}

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder="例如：Rank IC 绝对值 > 0.05 的一次验证 Top 20"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void onSubmit(event as unknown as FormEvent);
            }
          }}
        />
        <div className="composer-actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={showTools}
              onChange={(event) => setShowTools(event.target.checked)}
            />
            显示工具
          </label>
          <button type="button" onClick={onClear}>
            清空
          </button>
          {busy ? (
            <button type="button" onClick={() => void stop()}>
              停止
            </button>
          ) : null}
          <button type="submit" className="primary" disabled={busy || !input.trim()}>
            {busy ? "生成中…" : "发送"}
          </button>
        </div>
      </form>
    </div>
  );
}
