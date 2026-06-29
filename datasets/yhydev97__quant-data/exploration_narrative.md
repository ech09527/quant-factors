# 数据探索报告

**目标文件：** `futures/um/klines/1h.parquet`  
**数据集：** `yhydev97/quant-data`（Binance USDT 本位永续合约 1 小时 K 线）  
**探索时间：** 2026-06-29  
**全量规模：** 约 1,005 万行 · 523 个交易对 · 时间跨度 2020-01-01 ～ 2026-05-31

---

## 数据概述

本文件为 **Binance UM（U 本位）永续合约 1 小时 OHLCV K 线** 的聚合表，采用标准 Binance K 线字段布局，并附加 `symbol` 作为横截面标识。主键为 `(symbol, open_time)`，同一合约在同一开盘时刻仅对应一根 K 线。

| 维度 | 全量统计 | 抽样说明（head 5000 行） |
|------|----------|--------------------------|
| 行数 | 10,051,729 | 5,000（非全量） |
| 合约数 | 523 | 仅见 `0GUSDT` 1 个 |
| 时间范围 | 2020-01-01 ～ 2026-05-31 | 2025-09-17 ～ 2026-04-13 |
| 文件大小 | ~591 MB | — |
| Parquet 行组 | 82 | — |

**业务定位：** 多合约、多时段的统一面板数据，适用于**横截面动量/反转、成交量/资金流、微观结构**等因子研究，以及 1h 频率的中低频策略回测。

**字段分组：**

- **时间与标识：** `open_time`, `close_time`, `symbol`
- **价格：** `open`, `high`, `low`, `close`
- **成交规模：** `volume`, `quote_volume`, `count`
- **主动买入：** `taker_buy_volume`, `taker_buy_quote_volume`
- **占位：** `ignore`（恒为 0，可忽略）

---

## 字段语义与因子潜力

### open_time / close_time

- **语义：** K 线开盘/收盘时刻（epoch 毫秒）。`close_time` 通常为 `open_time + 3,599,999 ms`（1 小时 bar 右闭区间）。
- **因子潜力：** 时间对齐、日历效应（UTC 小时/星期）、bar 完整性校验、缺失 bar 检测。本身一般不作为 alpha 源，而是面板索引与回测时间轴。

### symbol

- **语义：** 永续合约交易对（如 `BTCUSDT`、`1000PEPEUSDT`）。
- **因子潜力：** 横截面分组、行业/主题聚类、上市时长分层。523 个合约覆盖主流币、meme、1000 倍计价等特殊品种，横截面广度较好。

### open / high / low / close

- **语义：** 1 小时内的开高低收价（USDT 计价）。
- **因子潜力（高）：**
  - **动量/反转：** 基于 `close` 的多周期收益率、相对强弱
  - **波动：** `(high - low) / close`、True Range、Parkinson 波动率
  - **K 线形态：** `(close - open) / open` 实体、上/下影线占比
  - **极值位置：** `(close - low) / (high - low)` 收盘在 bar 内位置（CLV）
- **抽样观察：** 非空样本中 OHLC 逻辑约束全部满足（high ≥ max(open,close,low)，low ≤ min(...)）。

### volume

- **语义：** 该小时内成交的**基础资产数量**（合约张数折算后的标的数量，非 USDT 名义）。
- **因子潜力（高）：**
  - 成交量异常（相对自身历史均值/标准差）
  - 量价背离（价涨量缩 / 价跌量增）
  - 横截面相对成交量排名
- **注意：** 不同合约标的单位差异大（如 `1000PEPE` vs `BTC`），横截面比较宜配合 `quote_volume` 或做标准化。

### quote_volume

- **语义：** 该小时内成交的 **USDT 名义成交额**（价格 × 数量之和）。
- **因子潜力（高）：**
  - **流动性/关注度：** 横截面成交额排名、成交额变化率
  - **换手率代理：** `quote_volume / close` 或相对市值（若有外部市值数据）
  - 与 `volume` 联用可构造**典型成交价格** `quote_volume / volume`（VWAP 近似）
- **横截面可比性优于 `volume`**，更适合多合约因子排序。

### count

- **语义：** 该小时内成交**笔数**（trade count）。
- **因子潜力（中高）：**
  - **微观结构：** 平均单笔规模 ≈ `volume / count` 或 `quote_volume / count`
  - 高频参与者活跃度、拆单 vs 大单主导
  - 笔数突增而价格不动 → 潜在吸筹/派发信号
- **局限：** 1h 聚合后笔数信息部分平滑，更适合作为辅助特征而非单一 alpha。

### taker_buy_volume / taker_buy_quote_volume

- **语义：** 主动买入（taker buy）的基础资产数量 / USDT 名义成交额。
- **因子潜力（很高）：**
  - **订单流不平衡：** `taker_buy_volume / volume`（主动买入占比）
  - **资金方向：** 主动买入额 vs 主动卖出额（`quote_volume - taker_buy_quote_volume`）
  - 多周期累积订单流、与价格变化的 lead-lag 关系
- **抽样观察：** `taker_buy_volume ≤ volume` 恒成立，字段一致性良好。
- **这是本数据集相对纯 OHLCV 的核心增量信息**，适合构建 short-horizon 资金流类因子。

### ignore

- **语义：** Binance API 保留字段，抽样中恒为 0。
- **因子潜力：** 无。建模与特征工程可直接剔除。

---

## 数据质量与限制

### 1. 抽样偏差（重要）

- 统计摘要基于每文件 **head 5000 行**，抽样时间窗仅为 **2025-09-17 ～ 2026-04-13**，且**仅含 1 个 symbol（0GUSDT）**。
- 全量实际覆盖 **523 合约、2020 ～ 2026**，横截面多样性、早期行情、长尾小币特征在抽样中**严重低估**。
- **建议：** 因子研究前按 `symbol` 分层抽样或全量扫描，勿依赖 head 抽样结论。

### 2. 缺失值

- 各数值列 null_rate ≈ **0.16%**（抽样）；对 50k head 复核约 **0.14%**。
- 缺失表现为**整行多列同时缺失**（非单列 sporadic null），`symbol` 无缺失。
- 全量约 1,600 行级别缺失（估算），比例低但需明确处理策略（删除 vs 前向填充——价格字段填充需谨慎）。

### 3. 上市时间与 survivorship 偏差

- 523 合约中，**213 个首次出现于 2025 年**，37 个在 2026 年；仅 58 个自 2020 年起即有数据。
- 横截面回测若未做 **point-in-time  universe** 过滤，易引入**幸存者/新币偏差**（新上市 meme 币波动与流动性结构异于老币）。

### 4. 时间跨度与频率

- 全量 6.4+ 年 1h 数据，覆盖 2020 加密牛市、2022 熊市、2024–2025 ETF/alt season 等 regime。
- **1h 频率**适合中低频因子；微观结构类因子（如 `count`）的信息量低于 tick/1m 数据。
- 需验证各 symbol 是否存在**缺失小时 bar**（网络/API 历史缺口），当前摘要未做完整性审计。

### 5. 数据类型与工程细节

- `open_time`、`close_time` 等为 **float64** 而非 int64/datetime，合并与排序时需显式转换，避免浮点精度导致 join 失败。
- Kaggle 挂载路径为 `/kaggle/input/datasets`，非期望的 `/kaggle/input/yhydev97-quant-data`；脚本中路径需兼容处理。

### 6. 横截面可比性

- 合约命名含 **1000 倍计价**（如 `1000PEPEUSDT`），`volume` 单位不统一；跨品种比较应优先 `quote_volume`、`taker_buy_quote_volume` 或收益率类因子。
- 小币 `quote_volume` 极低时，因子噪声大，宜设流动性门槛（如 24h 成交额分位数过滤）。

### 7. 全量 row_count 与抽样 row_count 混淆

- 摘要中 `row_count: 5000` 为抽样行数，**不是**全量 10,051,729；产能规划、内存估算须以全量为准。

---

## 推荐因子研究方向

以下均为**方向性建议**，均基于真实列名，不涉及完整公式实现。

1. **close 多周期动量 / 反转**  
   利用 `close` 计算 6h、24h、72h 收益率或相对强弱，在 523 合约横截面上排序；可结合上市时长分层，缓解新币偏差。

2. **high–low 区间波动（Realized Range）**  
   基于 `high`、`low`、`close` 构造 bar 内波动率或 `(high - low) / close`，用于波动率因子、风险调整收益、以及“低波动突破”类信号。

3. **quote_volume 流动性异常**  
   用 `quote_volume` 相对自身过去 N 根的 z-score 或横截面分位数，识别放量/缩量；可与 `close` 收益率交互，检验量价配合度。

4. **taker_buy_volume 主动买入占比（Order Flow Imbalance）**  
   用 `taker_buy_volume / volume` 衡量主动买压；可做多周期累积，或与 contemporaneous `close` 收益做 divergence 检测。

5. **taker_buy_quote_volume 资金侧不平衡**  
   基于 `taker_buy_quote_volume` 与 `quote_volume` 的差值或比例，构造 USDT 维度的净主动流；横截面排序对 meme/小市值合约可能更有效。

6. **volume / count 平均单笔规模（Trade Size Proxy）**  
   用 `volume / count` 或 `quote_volume / count` 刻画大单 vs 散户主导；笔数高而单笔小可能对应 retail 涌入 regime。

7. **open–close 实体动量（Intrabar Direction）**  
   用 `open`、`close` 构造 bar 实体方向与幅度，可与 `(high - low)` 波动结合，区分“趋势 bar”与“震荡 bar”。

8. **close 在 bar 内极值位置（CLV）**  
   用 `close`、`high`、`low` 构造收盘相对位置，衡量小时内多空博弈结果；适用于短周期反转/延续判断。

9. **quote_volume / volume 典型价偏离（VWAP Deviation）**  
   用 `quote_volume / volume` 作为 bar VWAP 近似，与 `close` 偏离度结合，识别价格相对成交均价的 overextension。

10. **横截面 quote_volume 加权动量**  
    对 `close` 收益率按 contemporaneous `quote_volume` 或 `taker_buy_quote_volume` 加权，强调“有资金参与的 move”，降低无流动性噪声合约权重。

---

## 因子设计注意事项

**面板对齐：** 以 `(symbol, open_time)` 为主键做 wide/long 转换；多合约 join 时统一 `open_time` 时区（UTC）与 bar 边界。

**流动性过滤：** 回测前建议按 `quote_volume` 滚动均值设阈值，剔除长期低流动性合约，降低滑点与不可交易假设误差。

**Point-in-time Universe：** 按各 symbol 首次出现 `open_time` 动态纳入，避免使用“当前 523 合约列表”回溯历史。

**缺失处理：** 优先删除 OHLC 全空行；避免对价格列无脑 ffill 制造虚假收益率。可单独构造 `is_missing_bar` 标志作为风控特征。

**Regime 分层：** 2020–2026 市场结构变化大，因子 IC 建议分年度/分波动 regime 检验，防止过拟合单一市场阶段。

**订单流因子衰减：** `taker_buy_volume`、`taker_buy_quote_volume` 在 1h 频率上预测力可能短于更高频数据，宜与较长周期 `close` 动量/filter 组合，并关注 turnover。

**特殊合约单位：** 含 `1000` 前缀的合约在 `volume` 维度不可直接与 BTC/ETH 比较；横截面因子优先使用无量纲比率（如占比、收益率）或 `quote_volume` 名义维度。

**ignore 字段：** 可直接 drop，不参与特征与存储。

**路径与环境：** 在 Kaggle 上使用 `/kaggle/input/datasets/yhydev97/quant-data/futures/um/klines/1h.parquet`；本地或其他环境需对应调整，并验证 parquet 分 82 个 row group 的并行读取策略以控制内存（全量约 600MB，可全内存或按 symbol 分区加载）。

---

*本报告基于确定性统计摘要及全量元数据（行数、合约数、时间范围）与 head 样本一致性校验；除已验证项外，bar 完整性、全量缺失分布、极端行情 outlier 仍需在全量 EDA 阶段进一步确认。*
