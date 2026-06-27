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

## 仓库结构

```
quant-factors/
├── README.md
└── .github/
    └── workflows/
        └── relay-forward.yml   # AI Workflow 事件转发
```

后续可在此仓库中补充 notebook、脚本、因子定义与文档；投研任务按目录组织，各目录附带对应的 `kernel-metadata.json`。

## 相关链接

- 仓库：<https://github.com/ech09527/quant-factors>
- Issue 跟踪：<https://github.com/ech09527/quant-factors/issues>
- Kaggle CLI：<https://github.com/Kaggle/kaggle-cli>
- Kaggle API：<https://github.com/Kaggle/kaggle-api>
