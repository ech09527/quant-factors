# Factor Validation D1 Cron（Cloudflare Worker）

每 **2 分钟** 通过 GitHub `workflow_dispatch` 触发 `factor-evaluation-d1.yml`（D1 验证批处理）。

## 架构

```
Cloudflare Cron (*/2 * * * *)
  → Worker 使用 Secret GITHUB_PAT
  → POST /repos/.../actions/workflows/factor-evaluation-d1.yml/dispatches
  → GitHub Actions 执行 run_d1_validation_batch.py
  → 拉取 pending 验证任务 → Jupyter 评估 → 回写 D1
```

## 部署

```bash
export CLOUDFLARE_API_TOKEN=...
export GITHUB_PAT=...
cd workers/factor-validation-d1-cron
./deploy.sh
```

## 手动测试

```bash
curl -X POST "https://quant-factors-factor-validation-d1-cron.<subdomain>.workers.dev"
```

## 默认触发参数（`wrangler.toml`）

| 变量 | 默认 |
|------|------|
| `MAX_VALIDATION_ITEMS` | `10` |
| `SAMPLE_START` | `2023-01-01` |
| `JUPYTER_SERVER_KEY` | `kaggle-kkb-prod` |

GitHub Actions 需配置 Secrets：`OPENAI_*`、`FACTOR_API_BASE_URL`、`FACTOR_API_TOKEN`。
