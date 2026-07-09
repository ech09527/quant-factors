# Factor Ideas Cron（Cloudflare Worker）

每日 UTC 06:00 通过 GitHub `workflow_dispatch` 触发 `factor-ideas.yml`（Cursor Agent 自主查 K 线生成想法）。

## 架构

```
Cloudflare Cron (0 6 * * *)
  → Worker 使用 Secret GITHUB_PAT
  → POST /repos/.../actions/workflows/factor-ideas.yml/dispatches
  → GitHub Actions 执行因子想法流水线（mode=agent_generate）
```

## 部署

```bash
export CLOUDFLARE_API_TOKEN=...
export GITHUB_PAT=...
cd workers/factor-ideas-cron
./deploy.sh
```

## 手动测试

```bash
curl -X POST "https://<worker-subdomain>.workers.dev"
```

## 默认触发参数

- `max_ideas=3`
- `mode=agent_generate`

可在 `wrangler.toml` 的 `[vars]` 中修改。
