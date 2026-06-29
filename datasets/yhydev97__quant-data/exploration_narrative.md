# 数据探索报告

**目标文件：** `futures/um/klines/1h.parquet`  
**数据集：** `yhydev97/quant-data`（Binance USDT 永续合约 1 小时 K 线）  
**探索时间：** 2026-06-29  
**全量规模（已验证）：** 约 1,005 万行 × 13 列，523 个交易对，时间跨度 2020-01-01 至 2026-05-31

---

## 数据概述

本文件为 Binance UM（U 本位永续）标准 1h K 线宽表，每行对应一个 `(symbol, open_time)` 小时 bar。主键为 `symbol` + `open_time`。

| 维度 | 全量统计 | 抽样统计（head 5000 行） |
|------|----------|--------------------------|
| 行数 | 10,051,729 | 5,000（非全量） |
| 交易对数 | 523 | 1（`0GUSDT`） |
| 时间范围 | 2020-01-01 ~ 2026-05-31 | 2025-09-17 ~ 2026-04-13 |
| 文件大小 | ~591 MB | — |

**数据形态：** 多 symbol 纵向堆叠；老牌主流币（如 BTCUSDT）约 56,232 条有效小时 bar，覆盖完整 6.4 年；新上市币（如 `0GUSDT`）仅约 6,162 条，自 2025-09-17 起。价格量级因品种差异大（抽样 min≈0.44，max≈7.15，对应小市值新币），全量横截面跨度更大。

**字段分组：**

- **时间与标识：** `open_time`, `close_time`, `symbol`
- **OHLC 价格：** `open`, `high`, `low`, `close`
- **成交与微观结构：** `volume`, `quote_volume`, `count`, `taker_buy_volume`, `taker_buy_quote_volume`
- **占位：** `ignore`（恒为 0 或 NaN，无业务信息）

---

## 字段语义与因子潜力

### open_time

- **含义：** K 线开盘时刻（Unix 毫秒时间戳），bar 左边界。
- **因子潜力：** 低（通常作索引/对齐）；可用于构造 session 因子（亚/欧/美时段）、周末效应、Funding 前后窗口（需外接 funding 数据）。
- **统计：** 全量约 12.58% 缺失；有效行唯一性良好。抽样 4992/5000 unique 系 head 抽样落在单一 symbol 连续时段所致。

### open / high / low / close

- **含义：** 该小时开盘价、最高价、最低价、收盘价（USDT 计价）。
- **因子潜力：** **核心价量因子源**
  - 收益率：`close` 多周期动量/反转
  - 波动：`high`−`low` 振幅、真实波幅（需前 bar `close`）
  - 形态：上/下影线、实体占比、缺口（`open` vs 前 `close`）
  - 横截面：相对 BTC/ETH 强弱、行业内排名
- **统计：** 与 `open_time` 同步缺失；全量 OHLC 逻辑违规 0 条；`quote_volume ≈ volume × close` 中位数 ≈ 1.0，数据自洽。

### volume

- **含义：** 该小时基础资产成交量（如 BTC 张数/币数，非 USDT）。
- **因子潜力：** **流动性与参与度**
  - 放量突破、量价背离
  - 相对历史均量（RVOL）
  - 横截面：低流动性溢价/折价
- **统计：** 抽样 67204 ~ 1.42e8，品种间不可直接横截面对比，需标准化。

### close_time

- **含义：** K 线收盘时刻（毫秒），通常为 `open_time + 3599999 ms`（1h bar 右闭边界）。
- **因子潜力：** 极低；可用于校验 bar 完整性、检测异常截断。
- **统计：** 有效行中 close−open 恒为 3,599,999 ms，格式规范。

### quote_volume

- **含义：** 该小时 USDT 名义成交额。
- **因子潜力：** **美元流动性因子**
  - 比 `volume` 更适合跨品种比较
  - 与 `volume` 比值 → 隐含均价，可检测异常成交
  - 横截面成交额排名、流动性分层
- **统计：** 与 `volume` 高度相关；全量 p01~p99 相对 `volume×close` 在 0.98~1.02，质量良好。

### count

- **含义：** 该小时内成交笔数（trade count）。
- **因子潜力：** **交易活跃度 / 订单碎片化**
  - `quote_volume / count` → 平均每笔成交额（大单 vs 散户）
  - 高 count + 低 volume → 碎片化成交
  - 与 `volume` 背离 → 算法拆单或 HFT 活跃
- **统计：** 抽样 1,169 ~ 2,537,128，跨品种差异极大，需 log 或分位数标准化。

### taker_buy_volume

- **含义：** 主动买入（taker buy）的基础资产成交量。
- **因子潜力：** **订单流 / 微观结构（高价值）**
  - `taker_buy_volume / volume` → 主动买入占比（全量中位数 ≈ 0.49）
  - 持续 >0.5 → 买方主导；极端值 → 短期动量或反转信号
  - 与价格变动交互 → 量价确认的 order flow
- **统计：** 恒 ≤ `volume`，无违规；与 `taker_buy_quote_volume` 配套使用。

### taker_buy_quote_volume

- **含义：** 主动买入的 USDT 成交额。
- **因子潜力：** 与 `taker_buy_volume` 类似，但跨品种可比性更好；可构造 `taker_buy_quote_volume / quote_volume` 作为美元维度订单流因子。

### ignore

- **含义：** Binance API 保留字段，本数据集恒为 0 或 NaN。
- **因子潜力：** 无；因子构建时应排除。

### symbol

- **含义：** 永续合约交易对标识（如 `BTCUSDT`）。
- **因子潜力：** 分组键；可衍生 listing age（上市时长）、板块标签（需外接元数据）；新币（如 `0GUSDT`）与老币因子表现可能异质。
- **统计：** 无缺失；523 个 symbol；每 symbol 有效 bar 数 median ≈ 12,775，min 88，max 56,285。

---

## 数据质量与限制

### 1. 缺失值（约 12.58%）

- 12,644 行仅有 `symbol`，OHLCV 等字段全为 NaN；523 个 symbol 均受影响（多数约 52~53 条/symbol）。
- 推测为写入时的**占位/填充行**，非真实缺失 bar。有效行 10,039,085 条，`(symbol, open_time)` **无重复**。
- **建议：** 因子计算前 `dropna(subset=['open_time','close'])`；不要用 ffill 填充这些空行。

### 2. 抽样偏差（warnings 已提示）

- 探索摘要对每文件仅取 **head 5000 行**；Parquet 按 symbol 排序，`0GUSDT` 排在最前且含大量 NaN 占位行。
- 导致抽样仅见 1 个 symbol、时间范围被压缩至 2025-09 ~ 2026-04，**严重低估横截面多样性**。
- 全量验证：523 symbols，2020-01-01 ~ 2026-05-31；BTCUSDT 小时 bar **零缺口**。

### 3. 时间跨度与生存偏差

- 523 个 symbol 上市时间参差：新币历史 < 1 年，老币 ≈ 6.4 年。
- 回测若用统一起始日，有效样本随时间扩大；横截面因子需考虑 **listing filter** 或动态 universe。
- 数据截止 2026-05-31，不含之后行情；crypto  regime 变化大，2020–2022 与 2024–2026 因子表现可能分化。

### 4. 数据类型

- `open_time`/`close_time` 为 float64 而非 datetime/int64，合并与排序时需显式转换；毫秒精度足够 1h 粒度。

### 5. 路径与环境

- Kaggle 实际挂载 `/kaggle/input/datasets`，非期望的 `/kaggle/input/yhydev97-quant-data`；脚本需兼容路径探测。

### 6. 横截面可比性

- `volume`、`count` 等绝对量级跨品种不可比；因子应使用比率、z-score、分位数或 `quote_volume` 等美元维度。

### 7. 未包含的扩展信息

- 无 funding rate、持仓量（OI）、买卖盘深度、标记价格等；纯 K 线因子有天花板，微观结构因子仅限 taker 字段。

---

## 推荐因子研究方向

以下均基于真实列名，仅给出方向，不涉及完整公式。

1. **close 多周期动量 / 反转**  
   基于 `close` 计算 6h、24h、72h、168h 收益率；crypto 1h 尺度上短周期反转与中周期动量并存，可分层测试。

2. **high–low 已实现波动（振幅因子）**  
   用 `(high - low) / close` 或 log(`high`/`low`) 度量小时内波动；低波动突破、波动率聚类（GARCH 型）均有研究空间。

3. **taker_buy_volume / volume 订单流不平衡**  
   主动买入占比；可 rolling 平滑后与 `close` 收益同向/背离，检验短期价格发现。

4. **quote_volume 流动性异常（RVOL 美元版）**  
   当前 `quote_volume` 相对过去 N 小时均值的偏离；放量上涨 vs 放量下跌 asymmetry。

5. **count 与 quote_volume 的平均单笔规模**  
   `quote_volume / count` 反映成交粒度；大单主导时该值上升，可与 `taker_buy_quote_volume` 结合区分主动大单。

6. **OHLC 蜡烛形态（上影线压力）**  
   `(high - max(open, close)) / (high - low)` 衡量上方抛压；横截面排名作反转或 continuation 信号。

7. **taker_buy_quote_volume / quote_volume 美元订单流**  
   跨品种可比性优于币本位 ratio；适合横截面多空排序。

8. **open 相对前 bar close 的跳空（gap）**  
   需 lag(`close`)；1h 跳空在 crypto 连续交易里仍有信息，尤其重大事件前后。

9. **volume 与 quote_volume 隐含均价偏离**  
   `quote_volume / volume` 与 `close` 的偏离检测异常成交或价格冲击。

10. **symbol 上市时长 × close 动量（新币效应）**  
    用每 symbol 首次有效 `open_time` 至当前 bar 的 bar 数作 age；新上市币高波动、高 `count`，因子需分 regime 或分层回测。

---

## 因子设计注意事项

**清洗流程**  
先剔除 `open_time` 或 `close` 为 NaN 的占位行；按 `(symbol, open_time)` 排序；确认主键唯一后再 rolling / lag。

**避免前视偏差**  
所有 rolling、rank 均在 symbol 内按时间因果计算；横截面 rank 仅用 contemporaneous 截面，不用未来 bar。

**标准化**  
横截面因子优先用 `quote_volume`、`taker_buy_quote_volume` 等 USDT 字段；价量因子用收益率、比率或 symbol 内 z-score，避免绝对价格/量级污染。

**Universe 管理**  
动态过滤：最低 `quote_volume`、最少上市 N 根 bar、排除极端低流动性 symbol（min 88 bar 的尾部品种）。

**频率与持仓**  
1h bar 适合中短周期（4h~7d 持有）；与 funding（8h）、日线趋势因子结合时可降频或作 filter。

**样本外划分**  
建议按时间切分（如 2020–2024 训练，2025–2026 测试），并单独检验 2025 后新上市 symbol 子样本，避免生存偏差夸大 IC。

**数据扩展**  
若策略依赖 OI、funding、基差，需从同数据集其他路径或 API 补全；当前文件仅支撑价量 + 有限 order flow 因子族。

---

**结论：** 该文件是质量较好的 Binance UM 1h K 线宽表，523 个 symbol、约 6.4 年覆盖，OHLC 逻辑与 taker/volume 约束均通过校验。主要风险来自 **~12.6% 占位 NaN 行**（清洗即可）以及 **head 抽样导致的 symbol/时间认知偏差**（全量分析已纠正）。因子研究应优先挖掘 `close` 价量、`quote_volume` 流动性、`taker_buy_volume` / `taker_buy_quote_volume` 订单流三类信号，并严格处理横截面标准化与上市时长异质性。
