# Factor Evaluation Batch Cron（Cloudflare Worker）

每 15 分钟通过 GitHub `workflow_dispatch` 触发 `factor-evaluation.yml`（因子评估）。

## 架构

```
Cloudflare Cron (*/15 * * * *)
  → Worker 从 Vault 读取 GITHUB_PAT (kv/github/quant-factors)
  → POST /repos/.../actions/workflows/factor-evaluation.yml/dispatches
  → GitHub Actions 执行因子评估（并行 Cursor + 单次 Kaggle 批量计算）
```

## Vault 凭证

| 路径 | 键 | 用途 |
|------|-----|------|
| `kv/cloudflare` | `API_KEY` | Wrangler 部署（Cloudflare API Token） |
| `kv/github/quant-factors` | `GITHUB_PAT` | Worker 运行时读取，触发 workflow |

部署脚本 `deploy.sh` 从 Vault 读取 Cloudflare API Key；Worker 运行时 Secret `VAULT_TOKEN` 用于读取 GitHub PAT。

## 部署

```bash
export VAULT_ADDR=https://vault.nocsdn.com
export VAULT_TOKEN=<your-vault-token>

cd workers/factor-evaluation-batch-cron
./deploy.sh
```

## 手动测试

部署后对 Worker URL 发 POST 可立即触发一次（与 cron 相同逻辑）：

```bash
curl -X POST "https://quant-factors-factor-evaluation-cron.<subdomain>.workers.dev"
```

## 默认触发参数

- `max_ideas=5`
- `sample_start=2023-01-01`
- `force=false`

可在 `wrangler.toml` 的 `[vars]` 中修改。
