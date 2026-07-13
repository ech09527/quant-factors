import assert from "node:assert/strict";
import {
  computeDensityCurve,
  interpolateCurveDensity,
  pickDensityHover,
} from "../pages/factor-dashboard/ic-density-chart.js";

const samples = [-0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.02, 0.01];
const model = computeDensityCurve(samples, 8);

assert.equal(model.count, samples.length);
assert.ok(Number.isFinite(model.mean));
assert.ok(model.maxDensity > 0);
assert.equal(model.bins.length, 8);
assert.ok(model.curve.length > 8);

const pick = pickDensityHover(model, 0.5);
assert.ok(pick.binEnd > pick.binStart);
assert.ok(Number.isFinite(pick.kdeDensity));
assert.ok(interpolateCurveDensity(model.curve, model.min) != null);

const empty = computeDensityCurve([], 8);
assert.equal(empty.count, 0);
assert.equal(empty.bins.length, 0);

console.log("ic_density_chart_test: ok");
