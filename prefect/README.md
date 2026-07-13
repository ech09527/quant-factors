# quant-factors Prefect 执行

## 部署（自建 Prefect Server）

```bash
export PREFECT_API_URL="https://your-prefect-server/api"
export PREFECT_API_KEY="..."
export FACTOR_API_BASE_URL="https://quant-factors-dashboard.pages.dev"
export AUTH_PASSWORD="..."   # Worker report Bearer
# MLflow 凭证
export MLFLOW_TRACKING_URI="..."
export MLFLOW_TRACKING_USERNAME="..."
export MLFLOW_TRACKING_PASSWORD="..."

cd prefect
uv sync
uv run python deploy.py --work-pool quant-factors-eval --concurrency 10

# 启动 worker（与 parquet 数据同机）
export QUANT_DATA_PATH="/path/to/data-root"   # 实际文件: $QUANT_DATA_PATH/quant-data/futures/um/klines/1h.parquet
uv run prefect worker start --pool quant-factors-eval
```

## Flow

| Deployment | Flow |
|------------|------|
| `factor-validation/production` | DuckDB 评估 + MLflow |
| `test-factor-validation/production` | Mock 评估（可 `TEST_FACTOR_VALIDATION_SKIP_MLFLOW=1`） |

Worker 侧设置 `EXECUTION_BACKEND=prefect`（见 `workers/factor-ideas/wrangler.toml`），Cron 将通过 Prefect API 触发 flow run。
