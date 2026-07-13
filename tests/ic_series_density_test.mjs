import assert from "node:assert/strict";
import { aggregateIcSeriesDaily } from "../workers/factor-ideas/src/mlflow-ic-series.js";

const series = aggregateIcSeriesDaily({
  period_axis: "open_time",
  points: [
    { t: "1700000000000", ic: 0.01, rank_ic: 0.02 },
    { t: "1700003600000", ic: 0.02, rank_ic: 0.03 },
    { t: "1700086400000", ic: -0.01, rank_ic: -0.01 },
  ],
});

assert.equal(series.density.rank_ic.length, 3);
assert.equal(series.density.mean_rank_ic.length, 2);
assert.deepEqual(series.density.rank_ic, [0.02, 0.03, -0.01]);

console.log("ic_series_density_test: ok");
