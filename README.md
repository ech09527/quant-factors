# quant-factors

量化投研仓库，用于因子研究、数据分析与相关投研任务。

## 因子想法与验证（Cloudflare）

因子想法生成、存储、验证与 Dashboard 均已运行在 **Cloudflare Worker + D1 + Pages**，不再依赖 GitHub Actions 或 GitHub Project。

| 组件 | 路径 | 作用 |
|------|------|------|
| **factor-ideas Worker** | `workers/factor-ideas/` | LLM 生成想法、D1 存储、验证批处理、Jupyter 异步评估、report 回写 |
| **factor-dashboard** | `pages/factor-dashboard/` | Web 界面：想法列表、验证结果、配置管理 |
| **评估引擎** | `scripts/evaluate_engine.py` | DuckDB panel SQL + IC 指标（打包进 Worker assets） |

### 验证流程

```
Cron / POST /run-validation-batch
  → D1 拉取 pending 验证（仅 ideas.factor_sql 非空）
  → Jupyter（lynas-pub）fire-and-forget 提交评估代码
  → Kernel 内 DuckDB 评估
  → POST /api/workflow/validation-jobs/report 回写 D1
```

详见 `workers/factor-ideas/README.md`。

### 本地评估

```bash
uv run python scripts/run_local_factor_evaluation.py --help
```

## 数据集目录（GitHub Actions，可选）

`dataset-catalog.yml` 仍可通过 **手动** `workflow_dispatch` 在 Kaggle 探索数据集并更新 `datasets/` 目录（与因子验证链路无关）。

```bash
gh workflow run dataset-catalog.yml
```

## Kaggle 环境（数据集探索）

数据集探索 Kernel 位于 `explorations/explore-dataset/`。前置配置与 CLI 用法：

1. 在 [Kaggle 账户设置](https://www.kaggle.com/settings) 创建 API Token。
2. 放置 `~/.kaggle/kaggle.json` 并 `chmod 600`。
3. `pip install kaggle` 或使用 `uv` 管理 Python 依赖。

```bash
kaggle kernels push -p explorations/explore-dataset
kaggle kernels logs <owner>/explore-dataset
```

## GitHub Actions 工作流

| 工作流 | 文件 | 作用 |
|--------|------|------|
| **数据集目录** | `dataset-catalog.yml` | Kaggle 探索 → 更新 `datasets/<slug>/` |
| **Issue 转发** | `relay-forward.yml` | 将 Issue 事件转发至 ai-workflow |

## 仓库结构

```
quant-factors/
├── workers/
│   └── factor-ideas/           # 主 Worker：想法 + 验证 + API
├── pages/
│   └── factor-dashboard/       # Dashboard（Pages）
├── scripts/
│   ├── evaluate_engine.py      # 评估引擎
│   ├── bundle_evaluate_kernel.py
│   └── export_worker_eval_assets.py
├── schemas/                    # 想法 / SQL / 评估 JSON Schema
├── datasets/                   # 数据集注册表与探索产出
├── explorations/
│   └── explore-dataset/        # Kaggle 数据集探索 Kernel
└── .github/workflows/
    ├── dataset-catalog.yml
    └── relay-forward.yml
```

环境变量示例见 `config/project.env.example`。

## 相关链接

- 仓库：<https://github.com/ech09527/quant-factors>
- Dashboard：<https://quant-factors-dashboard.pages.dev>
