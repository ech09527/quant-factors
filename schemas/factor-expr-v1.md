# Factor Expression DSL v1

Qlib 风格的因子表达式 DSL，用于将自然语言/公式草稿规范化为可去重的 canonical 字符串与 SHA-256 哈希。

## 语法概览

表达式支持两种等价写法：

1. **函数式**：`Div($ret_24h, Add($vol_24h, 1e-8))`
2. **中缀式**（`+` `-` `*` `/` 与括号）：`$ret_24h / ($vol_24h + 1e-8)`

字段以 `$` 前缀引用，例如 `$close`、`$volume`。解析后字段名会规范为小写并去掉 `$`。

常量支持整数、小数与科学计数法（如 `1e-8`）。

---

## 运算符分类

### 1. 字段（Field）

| 名称 | 说明 |
|------|------|
| `$open` | 开盘价 |
| `$high` | 最高价 |
| `$low` | 最低价 |
| `$close` | 收盘价 |
| `$volume` | 成交量 |
| `$quote_volume` | 成交额 |
| `$count` | 成交笔数 |
| `$taker_buy_volume` | 主动买入成交量 |
| `$taker_buy_quote_volume` | 主动买入成交额 |
| `$log_ret_1` | 1 期对数收益 |
| `$ret_24h` | 24 期收益 |
| `$vol_24h` | 24 期波动率 |

仅允许上述白名单字段；其他名称在 canonicalize 阶段报错。

### 2. 二元算术（Binary）

| 运算符 | 函数式 | 中缀 | 说明 |
|--------|--------|------|------|
| `Add` | `Add(a, b)` | `a + b` | 加法；**可交换**，canonical 时按 stable dump 排序子节点 |
| `Sub` | `Sub(a, b)` | `a - b` | 减法 |
| `Mul` | `Mul(a, b)` | `a * b` | 乘法；**可交换**，排序规则同 `Add` |
| `Div` | `Div(a, b)` | `a / b` | 除法 |

### 3. 一元变换（Unary）

| 运算符 | 签名 | 说明 |
|--------|------|------|
| `Neg` | `Neg(x)` 或 `-x` | 取负 |
| `Abs` | `Abs(x)` | 绝对值 |
| `Sign` | `Sign(x)` | 符号 |
| `Log` | `Log(x)` | 自然对数 |

### 4. 滚动窗口（Rolling）

第二个参数为窗口长度（通常为常数）。

| 运算符 | 签名 | 说明 |
|--------|------|------|
| `Ref` | `Ref(x, n)` | 滞后 n 期 |
| `Mean` | `Mean(x, n)` | 滚动均值 |
| `Std` | `Std(x, n)` | 滚动标准差 |
| `Sum` | `Sum(x, n)` | 滚动求和 |
| `Max` | `Max(x, n)` | 滚动最大值 |
| `Min` | `Min(x, n)` | 滚动最小值 |
| `Delta` | `Delta(x, n)` | `x - Ref(x, n)` |
| `Rank` | `Rank(x, n)` | 滚动秩 |
| `Med` | `Med(x, n)` | 滚动中位数 |
| `Quantile` | `Quantile(x, n)` | 滚动分位数 |

### 5. 双序列滚动（PairRolling）

| 运算符 | 签名 | 说明 |
|--------|------|------|
| `Corr` | `Corr(x, y, n)` | 滚动相关系数 |

### 6. 横截面（CrossSectional）

在每个时间截面上对所有标的进行变换。

| 运算符 | 签名 | 说明 |
|--------|------|------|
| `CSRank` | `CSRank(x)` | 横截面秩（百分位排名） |
| `CSZScore` | `CSZScore(x)` | 横截面 Z-Score |

---

## Canonical 规则

1. 字段名小写、去掉 `$`，且必须在白名单内。
2. `Add` / `Mul` 的子表达式按 `stableDump` 字典序排序，保证 `a+b` 与 `b+a` 等价。
3. 常数规范化：`1e-8` 等 epsilon 统一为 `const:1e-8` 表示。
4. `stableDump` 产出确定性字符串，例如：

   ```
   CSRank(Div(field:ret_24h,Add(const:1e-8,field:vol_24h)))
   ```

5. `exprHash` 对 canonical 字符串做 SHA-256（Web Crypto `crypto.subtle`），用于因子去重。

---

## TypeScript API

路径：`workers/factor-ideas/src/dsl/`

| 导出 | 说明 |
|------|------|
| `parseFactorExpr(input)` | 解析 DSL 字符串为 AST |
| `canonicalize(ast)` | 规范化 AST |
| `stableDump(obj)` | AST → 确定性字符串 |
| `exprHash(canonical)` | SHA-256 hex |
| `parseAndHash(factorExpr)` | 一站式：`{ canonical, hash }` 或 `{ error }` |
| `REGISTERED_OPS` | 内置算子名集合 |
| `ALLOWED_FIELDS` | 允许字段白名单 |

---

## 示例

```typescript
import { parseAndHash } from "./dsl";

const result = await parseAndHash("CSRank($ret_24h / ($vol_24h + 1e-8))");
// {
//   canonical: "CSRank(Div(field:ret_24h,Add(const:1e-8,field:vol_24h)))",
//   hash: "<64-char hex>"
// }
```

```typescript
parseFactorExpr("Mean($volume, 24)");
parseFactorExpr("Corr($close, $volume, 24)");
parseFactorExpr("Div($ret_24h, Add($vol_24h, 1e-8))");
```

---

## 版本

- **Schema ID**: `factor-expr-v1`
- **状态**: 初版，与 `workers/factor-ideas/src/dsl/` 实现同步
