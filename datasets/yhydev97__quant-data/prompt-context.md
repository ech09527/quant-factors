- **类型**：Binance USDT 永续合约 1h K 线（多标的面板：symbol × open_time）
- **Universe**：约 523 个 symbol，2020-01 ~ 2026-05
- **主键**：`symbol`, `open_time`（毫秒时间戳）
- **横截面**：每个 `open_time` 对 universe 内 symbol 做 rank/z-score；建议用 `quote_volume` 过滤低流动性

**可用字段（factor_expr 用 `$` 前缀，仅限下列白名单）**

| 字段 | 说明 |
|------|------|
| open, high, low, close | OHLC |
| volume, quote_volume, count | 量、额、笔数 |
| taker_buy_volume, taker_buy_quote_volume | 主动买入量/额 |
| log_ret_1, ret_24h, vol_24h | 派生：1 期对数收益、24 期收益、24 期波动 |

**DSL**：函数式 `Div($a, Add($b, 1e-8))` 或中缀 `$a / ($b + 1e-8)`；横截面用 `CSRank` / `CSZScore`；滚动窗口用 `Ref`/`Mean`/`Std`/`Delta`/`Corr` 等。
