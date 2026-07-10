# Worker 异步验证（lynas-pub）

验证批处理由 **factor-ideas Worker Cron** 驱动，不再依赖 GHA 队列。

## 流程

1. Cron（`*/5`）调用 `runValidationBatch`
2. 从 D1 拉取 pending 验证任务并 claim
3. 仅验证 `ideas.factor_sql` 已存在的想法（不再在验证批处理中调用 LLM 翻译）
4. 通过公网 `lynas-pub` 创建 Jupyter kernel，WebSocket **fire-and-forget** 提交评估代码
5. Kernel 内 DuckDB 评估完成后 **POST** `/api/workflow/validation-jobs/report` 回写 D1
6. 超时 `running` 任务由 `reclaimStaleValidationJobs`（默认 120 分钟）标为 failed
7. Cron 每 5 分钟运行 `runKernelCleanup`：对已完成验证（success/failed/skipped）删除对应 Jupyter kernel

## D1：`jupyter_servers` 需配置 `lynas-pub`

| 字段 | 说明 |
|------|------|
| `key` | `lynas-pub` |
| `base_url` | 公网 HTTPS Jupyter 根地址 |
| `ws_base_url` | 公网 WSS 根地址（可选，默认同 host） |
| `auth_token` | Jupyter token |
| `connect_mode` | `kernel_channels` |
| `proxy_url` | **留空**（Worker 不支持 HTTP 代理） |
| `runtime_config` | 含 `data_path` 等，如 `{"data_path":"/home/jovyan/work/quant-data/futures/um/klines/1h.parquet"}` |

## Worker 环境变量（`wrangler.toml` / Secrets）

| 变量 | 说明 |
|------|------|
| `VALIDATION_BATCH_ENABLED` | `1` 开启 Cron 验证 |
| `VALIDATION_JUPYTER_SERVER_KEY` | 默认 `lynas-pub`；若该 server **已禁用**，自动回退到下一个已启用且可直连的 server |
| `VALIDATION_BATCH_LIMIT` | 每轮最多处理条数，默认 `3` |
| `KERNEL_CLEANUP_ENABLED` | `1` 开启 Cron kernel 清理 |
| `KERNEL_CLEANUP_LIMIT` | 每轮最多清理 kernel 数，默认 `10` |
| `KERNEL_CLEANUP_GRACE_MINUTES` | 验证完成后至少等待分钟数再删 kernel，默认 `2` |
| `FACTOR_API_BASE_URL` | Kernel 回调的 Worker 公网 URL |
| `AUTH_PASSWORD` | 与 `FACTOR_API_TOKEN` 相同，用于 report API |

## D1：`llm_providers` 大模型 API 管理

支持 **多个 API 账户**、**每账户多个模型**、**每功能多条路由（优先级）**。失败时按 priority 自动切换下一条。

| 表 | 说明 |
|----|------|
| `llm_providers` | API 账户（base_url、api_key 等） |
| `llm_provider_models` | 账户下可用模型列表 |
| `llm_usage_routes` | 功能 → (provider, model) 路由，含 priority |

| 用途 (`usage_key`) | 说明 |
|--------------------|------|
| `idea_generation` | Cron / `/generate` 因子想法生成 |
| `validation_translation` | 验证批处理 SQL 翻译 |

REST：

- `GET/POST /api/llm-providers`
- `GET/PATCH/DELETE /api/llm-providers/:key`
- `GET/POST /api/llm-providers/:key/models`
- `PATCH/DELETE /api/llm-providers/:key/models/:model_name`
- `GET/POST /api/llm-usage-routes`
- `PATCH/DELETE /api/llm-usage-routes/:id`
- `GET /api/workflow/llm-config?usage=...`（返回 `routes[]` 按优先级排序）
- `GET /api/ideas/generation-prompt`（返回当前想法生成提示词；`?max_ideas=3` 对齐 Cron 条数；`?format=text` 纯文本）

可选 fallback（未配置 D1 时）：

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | Secret |
| `OPENAI_BASE_URL` | Secret |
| `OPENAI_MODEL` / `IDEA_OPENAI_MODEL` | wrangler vars |

## 手动触发

```bash
curl -X POST "https://<worker>/run-validation-batch" \
  -H "Authorization: Bearer $FACTOR_API_TOKEN"

curl -X POST "https://<worker>/run-kernel-cleanup" \
  -H "Authorization: Bearer $FACTOR_API_TOKEN"
```

## 部署前导出评估引擎

```bash
uv run python scripts/export_worker_eval_assets.py
cd workers/factor-ideas && ./deploy.sh
```

`deploy.sh` 会自动执行 export 再 `wrangler deploy`。
