# quant-factors

量化投研仓库，用于因子研究、数据分析与相关投研任务。

## 投研环境

本仓库的 Issue 与投研工作默认在以下 Jupyter Server 上执行：

| 项目 | 值 |
|------|-----|
| 地址 | `http://192.168.31.144:28888` |
| Token | `9527123` |

### 连接方式

在浏览器中打开：

```
http://192.168.31.144:28888/?token=9527123
```

或使用 Jupyter CLI / API 时，将上述地址与 token 作为连接参数。

## 工作流说明

- **下载数据集**：连接 Jupyter Server，在对应实例中下载或导入数据。
- **因子计算**：在 Jupyter Server 中编写并运行 notebook，完成因子构建、回测等任务。
- **相关性分析**：在 Jupyter Server 中加载因子数据，计算因子间或因子与收益的相关性。

所有与数据、计算相关的操作均应在该 Jupyter 环境中完成，以保证环境一致性与结果可复现。

## 仓库结构

```
quant-factors/
├── README.md
└── .github/
    └── workflows/
        └── relay-forward.yml   # AI Workflow 事件转发
```

后续可在此仓库中补充 notebook、脚本、因子定义与文档。

## 相关链接

- 仓库：<https://github.com/ech09527/quant-factors>
- Issue 跟踪：<https://github.com/ech09527/quant-factors/issues>
