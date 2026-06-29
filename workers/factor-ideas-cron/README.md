# Factor Ideas Cron（Cloudflare Worker）

每 5 分钟通过 GitHub `workflow_dispatch` 触发 `factor-ideas.yml`，替代不可靠的 GitHub Actions `schedule`。

## 架构

```
Cloudflare Cron (*/5)
  → Worker 从 Vault 读取 GITHUB_PAT (kv/github/quant-factors)
  → POST /repos/.../actions/workflows/factor-ideas.yml/dispatches
  → GitHub Actions 执行因子想法流水线
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

cd workers/factor-ideas-cron
./deploy.sh
```

## 手动测试

部署后对 Worker URL 发 POST 可立即触发一次（与 cron 相同逻辑）：

```bash
curl -X POST "https://<worker-subdomain>.workers.dev"
```

## 默认触发参数

与原先 schedule 分支一致：

- `max_ideas=1`
- `mode=generate_only`

可在 `wrangler.toml` 的 `[vars]` 中修改。
