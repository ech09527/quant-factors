# 数据探索报告

**目标文件：** `futures/um/klines/1h.parquet`  
**数据集：** `yhydev97/quant-data`（Binance USDT 本位永续合约 1 小时 K 线）  
**分析依据：** `exploration_summary` 确定性摘要 + 全量 Parquet 复核（约 1,005 万行）

---

## 数据概述

| 维度 | 全量统计 |
|------|----------|
| 数据类型 | 加密货币 UM 永续合约 OHLCV 面板 |
| 频率 | 1 小时（`open_time` 对齐整点） |
| 全量行数 | **10,051,729** |
| 全量 symbol 数 | **523** |
| 时间跨度 | **2020-01-01 → 2026-05-31**（`open_time`，epoch_ms） |
| 主键 | `(symbol, open_time)` |
| 文件大小 | ~591 MB |

**横截面轮动可行性：高。** 同一 `open_time` 下最多可同时覆盖 **523** 个 symbol；全样本每个小时 bar 平均约 **179** 个 symbol（中位数 **121**，P90 **444**）。早期（2020 年初）横截面仅 **3** 个 symbol，随新币上线逐步扩张至当前全量 universe，适合做**动态 universe 的截面多空/排序策略**，但须按时间分段设定可交易池，不能假设全历史恒为 523 币。

**抽样偏差提示：** head 5000 行抽样仅见 **1 个 symbol（0GUSDT）**，时间窗为 2025-09 至 2026-04，**不能代表横截面多样性**；下文横截面结论以 catalog 全量统计及全量复核为准。

---

## 面板结构与横截面可行性

### 面板结构

| 角色 | 字段 | 说明 |
|------|------|------|
| 分组键（截面维度） | `symbol` | 合约代码，如 `BTCUSDT`；523 个唯一值 |
| 时间轴（主） | `open_time` | K 线开盘时刻（毫秒时间戳），策略信号对齐点 |
| 时间轴（辅） | `close_time` | 收盘时刻（通常为 open_time + 1h − 1ms），用于校验 bar 完整性 |
| 频率 | 1h | 每小时一根 bar，`(symbol, open_time)` 唯一（有效行内无重复） |

### 每个 open_time 的可交易 symbol 规模（全量复核）

| 指标 | 值 |
|------|-----|
| 均值 | ~179 symbols / bar |
| 中位数 | 121 |
| P10 / P25 / P75 / P90 | 35 / 77 / 231 / 444 |
| 最小 / 最大 | 3（2020 初）/ 523（2026-05 末） |

按年活跃 symbol 数：2020 年 58 → 2021 年 91 → 2022 年 108 → 2023 年 176 → 2024 年 273 → 2025 年 486 → 2026 年 523，呈现典型的**幸存者扩张 + 新币冷启动**结构。

### 横截面 universe 构建要点

1. **时点对齐：** 以 `open_time` 为截面切片键；信号在 t 时刻生成，收益通常用 t→t+1 的 `close` 变化或下一 bar 收益，避免使用 `close_time` 之后的信息。
2. **动态 membership：** 某 symbol 仅在已有有效 bar 的 `open_time` 纳入 universe；新上市币历史短（最少约 **88** 根 bar，6 个 symbol < 1000 bar）。
3. **流动性过滤：** 建议用 `quote_volume`（USDT 计价成交额）做截面门槛，而非原始 `volume`（不同合约面值/精度不可比）。
4. **可交易池规模：** 近期全 bar 可达 523 币，但中位时点仅 ~121 币；策略容量与回测区间强相关。

---

## 字段语义与因子潜力

| 列名 | 业务含义 | 横截面 / 时序 | 因子方向（语义） |
|------|----------|---------------|------------------|
| `symbol` | 合约标识，USDT 永续 | 分组键 | 不直接作因子；用于截面分组与 universe |
| `open_time` | 1h bar 开盘时间戳 | 索引 | 不直接作因子；截面切片与滞后对齐 |
| `close_time` | bar 结束时间戳 | 索引 | 数据校验；一般不进入因子 |
| `open` | 开盘价 | 二者皆可 | 跳空幅度、相对前收偏离；截面：跨 symbol 比较开盘缺口 |
| `high` | 最高价 | 二者皆可 | 上影线、振幅；截面：同 bar 内相对波动排名 |
| `low` | 最低价 | 二者皆可 | 下影线、支撑距离；截面：同 bar 内回撤深度比较 |
| `close` | 收盘价 | 二者皆可 | 收益率、均线偏离；截面：过去 N 小时收益排名（动量/反转） |
| `volume` | 成交量（合约张数/币数） | 二者皆可 | 放量突破；**截面需与 `quote_volume` 配合或标准化** |
| `quote_volume` | 成交额（USDT） | **横截面优先** | 流动性分层、成交额异常、Amihud 非流动性；截面排序核心字段 |
| `count` | 成交笔数 | **横截面优先** | 交易活跃度、散户参与度；截面：笔均成交额 = quote_volume/count |
| `taker_buy_volume` | 主动买入量 | **横截面优先** | 买方压力；截面：taker_buy_volume / volume 跨 symbol 排序 |
| `taker_buy_quote_volume` | 主动买入额（USDT） | **横截面优先** | 主动资金流入；截面：占 quote_volume 比例（全样本均值 ~0.49） |
| `ignore` | Binance 保留字段 | 无 | 恒为 0，可忽略 |

---

## 数据质量与限制

### 通用质量

| 问题 | 详情 |
|------|------|
| 缺失值 | 全量约 **0.126%** 行在 OHLCV 及衍生列同时为 null（`symbol` 非空）；共 **12,644** 行 `open_time` 缺失，涉及全部 523 个 symbol |
| 主键唯一性 | 有效行（`open_time` 非空）上 `(symbol, open_time)` **无重复**；head 抽样显示的重复计数来自 null 行 |
| 路径警告 | Kaggle 实际挂载 `/kaggle/input/datasets`，非期望的 `yhydev97-quant-data` |
| 抽样局限 | 5000 行 head 仅 1 symbol，列 min/max、unique 等反映单币局部窗口，非全截面 |

### 横截面特有风险

1. **Symbol 覆盖不均：** 每个 bar 可用 symbol 数从 3 到 523 不等；2020–2022 截面很薄，回测若用固定 Top-N 需按年审视偏差。
2. **上市时间差异（冷启动）：** 4 个 symbol 历史不足约 1 个月（<720 bar），6 个 symbol <1000 bar；截面因子窗口（如 24h/168h）需 `min_periods` 与上市日过滤。
3. **流动性分层极端：** 平均 `quote_volume` Top（BTCUSDT ~5.5e8）与 Bottom（CARVUSDT ~1.1e5）相差 **>10⁴ 倍**；P90/P10 中位数比约 **14.5x**。截面排序若不过滤，小币噪音主导多空两端。
4. **不可比 volume：** `volume` 为合约数量，BTC 与 alt 绝对值不可横比；截面应优先 `quote_volume`、`count` 或比率类因子。
5. **幸存者偏差：** 523 为当前仍存续合约集合；已下架/合并合约可能不在库中，历史截面会系统性缺失“失败者”。
6. **抽样低估多样性：** 探索脚本 head 抽样易误判为单币时序数据；横截面研究必须全量或分层抽样（每 `open_time` 抽 N 币）。

---

## 推荐因子研究方向

1. **【横截面】截面动量：** 在同一 `open_time`，按各 symbol 过去 6h/24h/168h 的 `close` 收益率排序，做多赢家、做空输家（需统一 bar 对齐与缺失处理）。

2. **【横截面】截面反转：** 在同一 `open_time`，按过去 1h/4h `close` 涨跌幅反向排序，捕捉短周期 overreaction（小币上需叠加 `quote_volume` 门槛）。

3. **【横截面】主动买入强度：** 用 `taker_buy_volume / volume` 或 `taker_buy_quote_volume / quote_volume` 在同一 bar 跨 symbol 排序，识别相对买方压力。

4. **【横截面】流动性溢价/非流动性：** 在同一 `open_time`，用过去 24h 平均 `quote_volume` 或 \|return\|/`quote_volume`（Amihud 型）排序，检验小币风险补偿。

5. **【横截面】成交额异常：** 在同一 `open_time`，比较当前 bar `quote_volume` 与过去 N bar 均值的偏离（截面 z-score），捕捉异常放量 symbol。

6. **【横截面】成交笔数密度：** 用 `count` 与 `quote_volume/count`（笔均成交额）在同一时点跨 symbol 排序，区分散户扎堆 vs 大单主导。

7. **【横截面】波动率排序：** 用 `(high - low) / close` 或过去 N bar 的 `close` 实现波动率，在同一 `open_time` 跨 symbol 排序（低波/高波组合）。

8. **【时序】单标的均线偏离：** 对单个 `symbol` 计算 `close` 相对 MA(24/168) 的偏离，用于该币种的均值回归或趋势跟踪。

9. **【时序】单标的量价背离：** 在同一 `symbol` 时间序列上，比较 `close` 方向与 `quote_volume` 变化是否一致，识别局部衰竭。

10. **【时序】单标的 K 线形态：** 在同一 `symbol` 上用 `open/high/low/close` 构造上影线比例、实体占比等，作为该币种的短周期状态特征（不宜直接跨 symbol 比绝对价格）。

---

## 横截面因子设计注意事项

### Universe 过滤

- **最低历史长度：** 例如至少上市 168 个有效 bar 才进入截面池，避免新币噪音。
- **流动性门槛：** 建议以过去 24h 滚动 `quote_volume` 中位数或当前 bar `quote_volume` 设阈值（如剔除低于截面 P20）；全量末 bar 中位数约 **1.0e5 USDT/h**，P90 约 **1.27e6**。
- **有效 bar 要求：** 剔除 `open/high/low/close` 任一缺失的 `(symbol, open_time)`。

### 对齐与 lookahead

- 信号在 `open_time = t` 仅使用 ≤ t 的已闭合 bar（t  bar 在 t 整点开盘时，通常用 t−1 及更早 bar 更保守，取决于执行假设）。
- 收益标签用 `close(t+1)/close(t) − 1` 或 t+1 bar 开盘成交，**禁止**使用同 bar 的 `high/low` 作为已知信息（除非明确建模 intrabar 执行）。

### 中性化（无行业字段时的替代）

本数据集**无行业/赛道/市值分类字段**，Crypto 横截面可选替代：

| 替代维度 | 做法 |
|----------|------|
| 规模代理 | 用滚动 `quote_volume` 或 30d 平均成交额分桶，做规模中性 |
| BTC 暴露 | 对因子值回归 BTC 同期收益，取残差（Crypto 普遍高 Beta） |
| 主链/类型 | 需外部映射（L1/L2/DeFi/Meme）；本表 alone 无法做 |
| 截面标准化 | 每个 `open_time` 对因子做 cross-sectional z-score 或 rank，天然削弱量纲 |

### 组合构建

- **多空配对：** 按因子 rank 分 quintile/decile，Long top、Short bottom，建议 dollar-neutral 或 beta-neutral（对 BTC 回归）。
- **换手与成本：** 1h 频率下 turnover 高；`quote_volume` 低的分位需限制权重，避免不可交易。
- **缺失与停牌：** null 行不参与该时点排序；某 symbol 缺 bar 时勿 forward-fill 价格做收益。

---

## 与时序因子的区分

| 更适合时序（单 symbol 沿时间） | 更适合横截面（同 open_time 跨 symbol） |
|-------------------------------|----------------------------------------|
| `close` 的 MA、EMA、MACD、RSI | `close` 的**过去 N bar 收益率排名** |
| 单币 `volume` 相对自身历史均量 | `quote_volume`、`count` 的**截面分位** |
| 单币 K 线形态（影线、实体） | `taker_buy_volume/volume` 的**截面排序** |
| 单币波动率 regime 切换 | `(high−low)/close` 的**截面波动率排序** |
| 单币跳空回补模式 | 开盘缺口 `(open−prev_close)/prev_close` 的**截面比较** |

**原则：** 含 USDT 绝对金额（`quote_volume`、`taker_buy_quote_volume`）或比率（主动买入占比）的字段，优先做**截面 rank**；纯价格序列在去量纲（收益、波动率、相对均线）后可截面，但 raw `open/high/low/close` 绝对值不可跨 symbol 比较。

---

**结论：** 该文件是结构清晰的 **523×1h 加密货币 UM 面板**，主键 `(symbol, open_time)` 有效行唯一，**非常适合横截面因子研究**（动量/反转/主动买入/流动性类），但必须处理**动态 universe、流动性分层、早期薄截面、~0.13% 缺失行**及**无行业字段**等约束；`quote_volume` 应作为截面可交易性与因子构造的核心辅助列。
