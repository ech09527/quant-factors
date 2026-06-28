# quant-data

> 自动探索于 2026-06-28T12:13:19+00:00，Kaggle slug: `yhydev97/quant-data`

## 概述

- 输入路径: `/kaggle/input/datasets`
- 文件数: 1
- 抽样说明: 基于每个文件最多 5000 行抽样统计；row_count 为抽样行数而非全量。

## 时间范围

- 时间列: `open_time`
- 起止: 1970-01-01 ~ 1970-01-01

## 建议主键 / Join 键

`symbol`, `open_time`

## 因子字段候选

`open_time`, `open`, `high`, `low`, `close`, `volume`, `close_time`, `quote_volume`, `count`, `taker_buy_volume`, `taker_buy_quote_volume`, `ignore`

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

## 因子潜力（模板）

以下说明需结合业务语义人工补充：

| 列名 | 类型 | 说明 | 因子潜力 |
|------|------|------|----------|
| open_time | numeric | （待补充） | 动量、反转、波动等 |
| open | numeric | （待补充） | 动量、反转、波动等 |
| high | numeric | （待补充） | 动量、反转、波动等 |
| low | numeric | （待补充） | 动量、反转、波动等 |
| close | numeric | （待补充） | 动量、反转、波动等 |
| volume | numeric | （待补充） | 动量、反转、波动等 |
| close_time | numeric | （待补充） | 动量、反转、波动等 |
| quote_volume | numeric | （待补充） | 动量、反转、波动等 |
| count | numeric | （待补充） | 动量、反转、波动等 |
| taker_buy_volume | numeric | （待补充） | 动量、反转、波动等 |
