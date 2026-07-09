# Factor Evaluation Batch Cron（Cloudflare Worker）

每 15 分钟通过 GitHub `workflow_dispatch` 触发 `factor-evaluation.yml`（因子评估）。

## 架构

```
Cloudflare Cron (*/15 * * * *)
  → Worker 使用 Secret GITHUB_PAT
  → POST /repos/.../actions/workflows/factor-evaluation.yml/dispatches
  → GitHub Actions 执行因子评估
```

## 部署

```bash
export CLOUDFLARE_API_TOKEN=...
export GITHUB_PAT=...
cd workers/factor-evaluation-batch-cron
./deploy.sh
```

## 手动测试

```bash
curl -X POST "https://quant-factors-factor-evaluation-cron.<subdomain>.workers.dev"
```

## 默认触发参数

- `max_ideas=5`
- `sample_start=2023-01-01`
- `force=false`

可在 `wrangler.toml` 的 `[vars]` 中修改。
