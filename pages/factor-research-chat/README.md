# 因子研究助手（React）

独立对话页：流式展示、Markdown、可嵌入其他系统。

## 本地开发

```bash
cd pages/factor-research-chat
npm install
npm run dev
```

默认代理 `/api` → 生产 Dashboard。需在 URL 带 `?token=你的AUTH_PASSWORD`。

## 构建（写入 Dashboard 静态目录）

```bash
cd pages/factor-research-chat
npm run build
# 产物：pages/factor-dashboard/research-chat/
```

## 访问

- 独立页：`https://quant-factors-dashboard.pages.dev/research-chat/`
- 嵌入模式：`/research-chat/?embed=1`

## 嵌入其他系统

```html
<iframe
  id="qf-research"
  src="https://quant-factors-dashboard.pages.dev/research-chat/?embed=1"
  style="width:100%;height:640px;border:0;border-radius:12px"
></iframe>
<script>
  const frame = document.getElementById("qf-research");
  window.addEventListener("message", (event) => {
    if (event.data?.type === "qf-research-chat-ready") {
      frame.contentWindow.postMessage(
        { type: "qf-auth", token: "YOUR_BEARER_TOKEN" },
        "https://quant-factors-dashboard.pages.dev",
      );
    }
    if (event.data?.type === "qf-open-idea") {
      console.log("open idea", event.data.ideaId);
    }
  });
</script>
```

也可直接：`?embed=1&token=...`（注意不要把 token 写进可公开仓库）。

## API

前端通过 `@ai-sdk/react` `useChat` + UI Message Stream 调用：

`POST /api/factor-research-chat`（默认流式）

整段 JSON（兼容）：`POST /api/factor-research-chat?format=json`
