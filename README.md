# quant-factors

量化投研仓库，用于因子研究、数据分析与相关投研任务。

## 投研环境

本仓库的 Issue 与投研工作默认在 **Kaggle** 上执行。无特殊说明时，所有投研相关操作均通过 [Kaggle CLI](https://github.com/Kaggle/kaggle-cli) 或 [Kaggle API（Python SDK）](https://github.com/Kaggle/kaggle-api) 向 Kaggle 提交并运行代码，并实时或非实时获取运行日志。

### 前置配置

1. 在 [Kaggle 账户设置](https://www.kaggle.com/settings) 中创建 API Token，下载 `kaggle.json`。
2. 将凭证放置于 `~/.kaggle/kaggle.json`，并设置权限：

```bash
chmod 600 ~/.kaggle/kaggle.json
```

3. 安装 CLI / SDK：

```bash
pip install kaggle
```

### 提交与运行

Notebook / 脚本通过 Kaggle Kernel（Notebook）提交。每个任务目录需包含代码文件与 `kernel-metadata.json`（可用 `kaggle kernels init -p <目录>` 生成，或 `kaggle kernels pull -m` 拉取已有 Notebook 时一并获取）。

```bash
# 提交并运行（上传后自动触发执行）
kaggle kernels push -p <任务目录>

# 拉取已有 Notebook 与元数据
kaggle kernels pull <用户名>/<kernel-slug> -m -p <目录>
```

也可使用 Python SDK 完成同等操作，例如 `KaggleApi().kernels_push()`、`kernels_pull()` 等，详见 [Kaggle API 文档](https://github.com/Kaggle/kaggle-api)。

### 日志与状态

```bash
# 查看最新运行状态（运行中 / 成功 / 失败）
kaggle kernels status <用户名>/<kernel-slug>

# 获取执行日志
kaggle kernels logs <用户名>/<kernel-slug>

# 实时轮询日志（--follow 持续拉取新输出，--interval 控制轮询间隔秒数）
kaggle kernels logs <用户名>/<kernel-slug> --follow --interval 10

# 下载运行产出（数据、模型、日志文件等）
kaggle kernels output <用户名>/<kernel-slug> -p <输出目录>
```

非实时场景下，可先 `kernels status` 确认完成，再 `kernels logs` 或 `kernels output` 获取结果。

## 工作流说明

- **下载数据集**：通过 `kaggle datasets download` 或在 Notebook 内挂载 Kaggle Dataset；数据引用写入 `kernel-metadata.json` 的 `dataset_sources`。
- **因子计算**：在本地编写 notebook / 脚本，经 `kaggle kernels push` 提交至 Kaggle 运行，完成因子构建、回测等任务。
- **相关性分析**：在 Kaggle Notebook 中加载因子数据，计算因子间或因子与收益的相关性；运行日志通过 `kernels logs` 查看。

所有与数据、计算相关的操作均应在 Kaggle 环境中完成，以保证环境一致性与结果可复现。

### GitHub Actions 工作流

| 工作流 | 文件 | 作用 |
|--------|------|------|
| **A — 数据集目录** | `dataset-catalog.yml` | 探索 Kaggle 数据集，写入 `datasets/<slug>/schema.json` 与 README |
| **B — 因子想法** | `factor-ideas.yml` | Runner 编排 Kaggle Kernel；Cursor Agent 自主查 K 线并生成想法；Runner 去重后写入 Project（**不提交 git**） |
| **C — 因子评估** | `factor-evaluation.yml` | 拉取 N 条待评估想法 → Cursor 翻译 SQL → Kaggle 批量验证 → 写回 Project（**不提交 git**） |

因子想法与评估结果均只写入 **GitHub Project**（Draft Issue），不再写入或提交 `ideas/`、`evaluations/`、`expressions/`。待评估判定优先读取 Project body，并兼容仓库内已有的历史 `evaluations/*.json`。

**因子评估流程（工作流 C）**：

```
1. Runner 拉取 pending 想法
2. Runner 并行调用 Cursor，逐条生成 factor_sql（默认 2 路并发）
3. Runner 将所有 SQL 一次性提交 Kaggle Kernel，批量计算
4. Runner 拉取 batch_evaluations.json，逐条写回 Project
```

**手动触发**（需已配置 Secrets）：

```bash
# 工作流 A：更新数据集说明
gh workflow run dataset-catalog.yml

# 工作流 B：Kaggle Agent 查 K 线 + 生成因子想法（可选 max_ideas / dataset_slug / mode）
gh workflow run factor-ideas.yml
gh workflow run factor-ideas.yml -f max_ideas=5
gh workflow run factor-ideas.yml -f mode=explore_and_generate
gh workflow run factor-ideas.yml -f mode=generate_only

# 工作流 C：因子评估（默认最多 5 条待验证想法）
gh workflow run factor-evaluation.yml
gh workflow run factor-evaluation.yml -f max_ideas=10
gh workflow run factor-evaluation.yml -f max_ideas=0  # 不限制条数
gh workflow run factor-evaluation.yml -f force=true     # 强制重评
```

**定时触发**：

- **因子想法**：Cloudflare Worker（`workers/factor-ideas-cron/`）每 5 分钟调用 `factor-ideas.yml`（`max_ideas=3`、`mode=agent_generate`）
- **因子评估**：Cloudflare Worker（`workers/factor-evaluation-batch-cron/`）每 15 分钟调用 `factor-evaluation.yml`（`max_ideas=5`）；`Factor Ideas` 工作流完成后也会自动触发

凭证从 HashiCorp Vault 读取，见各 Worker 目录下的 README。

工作流 B 在 Kaggle Kernel 内由 Cursor Agent 自主查询 Parquet K 线并生成想法；Runner 负责拉取已有 Project 想法、注入约束、拉取 Kernel 产出、去重重试与写入 Project。

**Cursor 认证（工作流 B/C）**：凭据优先级为 **`CURSOR_AUTH_JSON` > `CURSOR_API_KEY` > `~/.config/cursor/auth.json`**。每次 `factor-ideas.yml` 运行时，Runner 从 GitHub Actions Secret 读取最新凭据，并在 `kernels push` 前嵌入 `kernel_inputs`（`cursor_auth_json` 或 `cursor_api_key`），Kaggle Kernel 优先使用该字段。**勿在 Kaggle Notebook Secret 中写死凭据**；本地调试时可依赖环境变量或已有 `auth.json`。

**所需 Secrets**（在仓库 Settings → Secrets and variables → Actions 中配置）：

| Secret | 用途 |
|--------|------|
| `KAGGLE_API_TOKEN` | 工作流 A/B：Kaggle API（推荐） |
| `KAGGLE_USERNAME` | 工作流 A/B：Kernel 所有者（与 token 联用） |
| `KAGGLE_KEY` | 工作流 A/B：旧版 Kaggle Key（可选） |
| `CURSOR_AUTH_JSON` | 工作流 B/C：Cursor CLI 认证 JSON（优先级最高；B 每次注入 Kaggle） |
| `CURSOR_API_KEY` | 工作流 B/C：Cursor API Key（`CURSOR_AUTH_JSON` 未配置时的备选） |
| `PROJECT_PAT` | 工作流 B：Project GraphQL 读写（推荐） |
| `AI_WORKFLOW_DISPATCH_TOKEN` | Issue 事件转发（`relay-forward.yml`） |

GitHub Project ID 见 `config/github-project.json`（非 Secret）。

> **说明**：更新 Cursor 登录后只需刷新 GitHub Actions Secret（`CURSOR_AUTH_JSON` 或 `CURSOR_API_KEY`），下次工作流 B 运行会自动把最新凭据传给 Kaggle，无需在 Kaggle Web UI 重复配置。

环境变量说明见 `config/project.env.example`；GitHub Project 元数据见 `config/github-project.json`。

## 仓库结构

```
quant-factors/
├── README.md
├── config/
│   └── project.env.example     # 环境变量示例（Project ID、Kaggle Kernel 等）
├── datasets/
│   ├── datasets.yaml           # 数据集注册表（slug、enabled 开关）
│   └── <owner__dataset>/       # 工作流 A 产出（slug 中 / 替换为 __）
├── explorations/
│   ├── explore-dataset/        # Kaggle 探索 Kernel（工作流 A）
│   └── generate-factor-ideas/  # Kaggle 因子想法 Kernel（工作流 B）
├── schemas/
│   ├── dataset-schema.json     # datasets/<slug>/schema.json 格式定义
│   └── idea-schema.json        # 因子想法 JSON 格式定义
├── scripts/                    # 确定性脚本（去重、校验、写入 Project 等）
└── workers/
    ├── factor-ideas-cron/              # Cloudflare Worker：每 5 分钟触发 factor-ideas
    └── factor-evaluation-batch-cron/   # Cloudflare Worker：每 15 分钟触发 factor-evaluation
└── .github/
    └── workflows/
        ├── relay-forward.yml   # AI Workflow 事件转发
        ├── dataset-catalog.yml # 工作流 A：定时更新 datasets/ 说明
        └── factor-ideas.yml    # 工作流 B：定时生成因子想法
```

- **datasets/**：Kaggle 数据集目录；`datasets.yaml` 注册 slug（`owner/name`），探索结果写入 `owner__name/` 子目录（斜杠替换为双下划线）。
- **explorations/**：通用 Kaggle Kernel，由 Actions 通过 CLI 提交并拉取产出。
- **scripts/**：去重、Schema 校验、Project 写入等非 LLM 逻辑。
- **schemas/**：JSON Schema，约束探索产出与因子想法的结构化格式。
- 投研任务按目录组织，各 Kernel 目录附带 `kernel-metadata.json`。

## 相关链接

- 仓库：<https://github.com/ech09527/quant-factors>
- Issue 跟踪：<https://github.com/ech09527/quant-factors/issues>
- Kaggle CLI：<https://github.com/Kaggle/kaggle-cli>
- Kaggle API：<https://github.com/Kaggle/kaggle-api>
