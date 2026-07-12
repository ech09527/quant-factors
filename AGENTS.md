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

## Jupyter 执行（仅维护新路径）

Jupyter kernel 执行以 **`jupyter_executions` + Queue + 短 WS dispatch + HTTP callback/heartbeat** 为唯一目标架构。

- **维护范围**：`test_factor_validation`、`factor_validation` 经 `buildJupyterExecutionCode` → `wrapJupyterExecutionCodeWithHttpCallback` 的路径（含 5s 心跳与完成回调）。
- **不必理会旧路径**：`legacy_validation`、`runTestFactorValidationBatch` / `runFactorValidationBatch` / `validation-batch` 等直连 Jupyter、长 WS、旧 HTTP report 的代码；后续应**全部删除**，新功能不要扩展或兼容这些路径。
