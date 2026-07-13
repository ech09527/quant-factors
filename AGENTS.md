# Agent 指南

## Python

运行 Python 脚本、安装 Python 依赖请使用 **uv**（例如 `uv run python ...`、`uv pip install ...`）。

## 密钥与部署（Vault）

部署 Cloudflare（`wrangler deploy` / `wrangler pages deploy`）或调用需鉴权的 Worker API 时，优先从 Vault 读取密钥，不要硬编码或写入仓库。

环境变量（通常已在 `workers/factor-ideas/.env` 中配置，勿提交）：

- `VAULT_ADDR` — 例如 `https://vault.nocsdn.com`
- `VAULT_TOKEN` — Vault 访问令牌

常用读取方式（`vault` CLI）：

```bash
# 加载 Vault 连接信息（若尚未 export）
set -a && source workers/factor-ideas/.env && set +a

# Cloudflare API Token（wrangler / Pages 部署）
export CLOUDFLARE_API_TOKEN="$(vault kv get -field=API_KEY kv/cloudflare)"

# Dashboard / Worker API Bearer（AUTH_PASSWORD）
export AUTH_PASSWORD="$(vault kv get -field=PASSWORD kv/quant-factors/auth)"
```

等价的 HTTP 读取（无 `vault` CLI 时）：

```bash
export CLOUDFLARE_API_TOKEN="$(
  curl -fsS -H "X-Vault-Token: $VAULT_TOKEN" \
    "$VAULT_ADDR/v1/kv/data/cloudflare" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).data.data.API_KEY))"
)"
```

### 部署示例

```bash
set -a && source workers/factor-ideas/.env && set +a
export CLOUDFLARE_API_TOKEN="$(vault kv get -field=API_KEY kv/cloudflare)"

# Worker
cd workers/factor-ideas && npx wrangler deploy

# Dashboard（Pages）
cd pages/factor-dashboard && bash deploy.sh
```

或一键部署（仍会尝试从仓库根 `.env` 读取；若无 token 请先按上文 export）：

```bash
bash scripts/deploy-qf-cloudflare.sh
```

## Jupyter / Prefect 执行

因子验证与测试验证默认经 **Prefect**（`EXECUTION_BACKEND=prefect`）：

- Worker Cron claim → `create_flow_run` → [prefect/flows](prefect/flows/) 在 work pool 上跑 DuckDB + MLflow
- 结果经现有 `/api/workflow/ml-tasks/report` 回写 D1
- 账本表：`prefect_flow_runs`（见 `migrations/0013_prefect_flow_runs.sql`）

回退 Jupyter 路径：设置 `EXECUTION_BACKEND=jupyter` 且 `JUPYTER_EXECUTION_VIA_DO=1`（需恢复 wrangler Queue + Durable Object 配置）。

- **维护范围**：`factor_validation`、`test_factor_validation` 经 [scripts/factor_validation_runner.py](scripts/factor_validation_runner.py) + Prefect flow。
- **不必理会旧路径**：`legacy_validation`、直连 Jupyter Coordinator/Queue 的 dispatch（`jupyter-execution-dispatch.js` 等）除回退外不再扩展。
