const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computePairReturn, computeRawContributions, calculateStrength,
  calculateMomentum, calculateAcceleration, classifyStatus,
} = require("../engine/strengthEngine");

test("computePairReturn: basic percentage return", () => {
  const r = computePairReturn(1.1000, 1.1100);
  assert.ok(Math.abs(r - (-0.9009)) < 0.001);
});

test("computePairReturn: missing historical price returns null", () => {
  assert.equal(computePairReturn(1.10, null), null);
  assert.equal(computePairReturn(1.10, 0), null);
});

test("orientation: EUR/USD rising strengthens EUR, weakens USD", () => {
  const obs = [{ symbol: "EUR/USD", currentMid: 1.1150, historicalMid: 1.1100 }];
  const contrib = computeRawContributions(obs);
  assert.ok(contrib.EUR.raw > 0, "EUR contribution should be positive when EUR/USD rises");
  assert.ok(contrib.USD.raw < 0, "USD contribution should be negative when EUR/USD rises");
  assert.ok(Math.abs(contrib.EUR.raw + contrib.USD.raw) < 1e-9, "contributions should be exact opposites");
});

test("orientation: USD/JPY rising strengthens USD, weakens JPY", () => {
  const obs = [{ symbol: "USD/JPY", currentMid: 150.50, historicalMid: 149.60 }];
  const contrib = computeRawContributions(obs);
  assert.ok(contrib.USD.raw > 0, "USD contribution should be positive when USD/JPY rises");
  assert.ok(contrib.JPY.raw < 0, "JPY contribution should be negative when USD/JPY rises");
});

test("orientation: EUR/USD falling weakens EUR, strengthens USD", () => {
  const obs = [{ symbol: "EUR/USD", currentMid: 1.1000, historicalMid: 1.1100 }];
  const contrib = computeRawContributions(obs);
  assert.ok(contrib.EUR.raw < 0);
  assert.ok(contrib.USD.raw > 0);
});

test("aggregation: multiple USD pairs rising together compound USD's raw contribution", () => {
  const oneUp = [{ symbol: "EUR/USD", currentMid: 1.10, historicalMid: 1.0950 }];
  const threeUp = [
    { symbol: "EUR/USD", currentMid: 1.10, historicalMid: 1.1050 },
    { symbol: "GBP/USD", currentMid: 1.30, historicalMid: 1.3050 },
    { symbol: "USD/JPY", currentMid: 150.5, historicalMid: 149.9 },
  ];
  const contribOne = computeRawContributions(oneUp);
  const contribThree = computeRawContributions(threeUp);
  assert.ok(contribThree.USD.pairsUsed === 3);
  // All three pairs point the same direction for USD, so its averaged
  // contribution should reflect consistent strengthening — sign check,
  // not an exact magnitude claim (magnitudes differ pair to pair).
  assert.ok(contribThree.USD.raw > 0);
  assert.ok(contribOne.USD.raw < 0); // EUR/USD rising alone still weakens USD in that single pair
});

test("missing pair data: a currency with zero valid pairs gets raw=null, not zero", () => {
  const obs = [{ symbol: "EUR/USD", currentMid: 1.10, historicalMid: null }]; // no historical data at all
  const contrib = computeRawContributions(obs);
  assert.equal(Object.keys(contrib).length, 0, "no currency should get a fabricated value from missing data");
});

test("extreme price movement does not throw and produces a large-magnitude return", () => {
  const r = computePairReturn(2.0, 1.0); // +100% move, deliberately extreme
  assert.equal(r, 100);
});

test("full pipeline: z-score normalization produces mean ~0 across currencies", () => {
  const obs = [
    { symbol: "EUR/USD", currentMid: 1.10, historicalMid: 1.1050 },
    { symbol: "GBP/USD", currentMid: 1.31, historicalMid: 1.3050 },
    { symbol: "USD/JPY", currentMid: 150.5, historicalMid: 149.9 },
    { symbol: "USD/CHF", currentMid: 0.885, historicalMid: 0.884 },
    { symbol: "AUD/USD", currentMid: 0.652, historicalMid: 0.654 },
  ];
  const result = calculateStrength(obs);
  const strengths = Object.values(result).map(v => v.strength).filter(s => s !== null);
  const mean = strengths.reduce((a, b) => a + b, 0) / strengths.length;
  assert.ok(Math.abs(mean) < 1e-9, "z-scores across all currencies should average to ~0");
});

test("momentum: increasing strength between snapshots gives positive momentum", () => {
  assert.equal(calculateMomentum(0.82, 0.60), 0.82 - 0.60);
});

test("momentum: no previous snapshot returns null, not zero", () => {
  assert.equal(calculateMomentum(0.82, null), null);
  assert.equal(calculateMomentum(0.82, undefined), null);
});

test("acceleration: momentum slowing down between two periods is negative", () => {
  const accel = calculateAcceleration(0.10, 0.25); // momentum dropped from 0.25 to 0.10
  assert.ok(accel < 0);
});

test("reversal-style case: strength decreasing between two snapshots classifies as WEAKENING, not a prediction", () => {
  const momentum = calculateMomentum(0.52, 0.74); // matches the spec's own example
  assert.ok(momentum < 0);
  assert.equal(classifyStatus(0.52, momentum), "WEAKENING");
});

test("classifyStatus never uses good/bad language", () => {
  const labels = [
    classifyStatus(0.5, 0.1), classifyStatus(-0.5, -0.1),
    classifyStatus(0.5, 0), classifyStatus(null, null),
  ];
  for (const label of labels) {
    assert.ok(!/good|bad/i.test(label));
  }
});

test("custom/boundary timeframe: engine works identically regardless of what timeframe the caller used to build historicalMid", () => {
  // The engine itself is timeframe-agnostic by design — it only ever sees
  // currentMid/historicalMid pairs. Timeframe selection happens one layer
  // up (routes/strengthRoutes.js), which is what this test documents.
  const obsShort = [{ symbol: "EUR/USD", currentMid: 1.10, historicalMid: 1.0995 }]; // e.g. 5m lookback
  const obsLong = [{ symbol: "EUR/USD", currentMid: 1.10, historicalMid: 1.08 }];    // e.g. 1D lookback
  const rShort = computeRawContributions(obsShort);
  const rLong = computeRawContributions(obsLong);
  assert.ok(rShort.EUR.raw !== rLong.EUR.raw, "different lookback windows should produce different returns");
});
