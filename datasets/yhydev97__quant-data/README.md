# quant-data

> 自动探索于 2026-06-29T05:19:38+00:00，Kaggle slug: `yhydev97/quant-data`

## 概述

- 数据类型（推断）: 加密货币永续合约 1 小时 K 线（Binance UM 格式）
- 输入路径: `/kaggle/input/datasets`
- 期望路径: `/kaggle/input/yhydev97-quant-data`
- 数据文件数: 1
- 抽样说明: 基于每个文件最多 5000 行抽样统计；row_count 为抽样行数而非全量。
- 抽样内 symbol 数: 1
- 全量行数: 10051729
- 全量 symbol 数: 523
- 全量时间范围: 2020-01-01 ~ 2026-05-31（epoch_ms）

## 文件树

- `yhydev97/quant-data/futures/um/klines/1h.parquet`

## 时间范围

- 时间列: `open_time`（Unix 毫秒解析）
- 起止: 2025-09-17 ~ 2026-04-13

## 建议主键 / Join 键

`symbol`, `open_time`

## 因子字段候选

`open`, `high`, `low`, `close`, `volume`, `quote_volume`, `count`, `taker_buy_volume`, `taker_buy_quote_volume`

## 文件与字段

### yhydev97/quant-data/futures/um/klines/1h.parquet

- 大小: 620,488,492 bytes
- 抽样行数: 5,000

| 列名 | 类型 | 缺失率 | 样本值 |
|------|------|--------|--------|
| open_time | float64 | 0.16% | 1758121200000.0, 1758124800000.0, 1758128400000.0 |
| open | float64 | 0.16% | 1.1, 1.5795, 1.7244 |
| high | float64 | 0.16% | 1.6625, 2.0175, 1.7366 |
| low | float64 | 0.16% | 1.1, 1.5643, 1.472 |
| close | float64 | 0.16% | 1.5811, 1.725, 1.5837 |
| volume | float64 | 0.16% | 7399769.0, 19513328.0, 11393202.0 |
| close_time | float64 | 0.16% | 1758124799999.0, 1758128399999.0, 1758131999999.0 |
| quote_volume | float64 | 0.16% | 11144900.7004, 33687993.1474, 18127404.8256 |
| count | float64 | 0.16% | 84732.0, 363154.0, 188515.0 |
| taker_buy_volume | float64 | 0.16% | 3756057.0, 9918900.0, 5664996.0 |
| taker_buy_quote_volume | float64 | 0.16% | 5672513.4148, 17142293.0178, 9020864.8285 |
| ignore | float64 | 0.16% | 0.0 |
| symbol | object | 0.00% | 0GUSDT |

## 已知限制 / 警告

- Kaggle 挂载路径非标准：实际 `/kaggle/input/datasets`，期望 `/kaggle/input/yhydev97-quant-data`
- 统计基于每文件最多 5000 行 head 抽样；row_count 为抽样行数，不代表全量。
- yhydev97/quant-data/futures/um/klines/1h.parquet 抽样中仅见 1 个 symbol，横截面多样性可能被低估。

## 字段说明

| 列名 | 类型 | 说明 | 因子潜力 |
|------|------|------|----------|
| open_time | float64 | K 线开盘时间（Unix 毫秒） | 时间轴 / 分组排序 |
| open | float64 | 开盘价 | 动量、反转、波动 |
| high | float64 | 最高价 | 波动、突破 |
| low | float64 | 最低价 | 波动、支撑阻力 |
| close | float64 | 收盘价 | 动量、反转、均线 |
| volume | float64 | 成交量（基础资产） | 量价、流动性 |
| close_time | float64 | K 线收盘时间（Unix 毫秒） | 时间轴 |
| quote_volume | float64 | 成交额（计价货币） | 流动性、冲击 |
| count | float64 | 成交笔数 | 微观结构、单笔规模 |
| taker_buy_volume | float64 | 主动买入成交量 | 订单流、冲击 |
| taker_buy_quote_volume | float64 | 主动买入成交额 | 订单流 |
| ignore | float64 | （待补充） | — |
| symbol | object | 交易对代码 | 分组键 |
