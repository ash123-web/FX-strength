const express = require("express");
const router = express.Router();
const db = require("../db/db");
const { getDataStatus, TIMEFRAMES } = require("../engine/ingest");
const { computeRawContributions, calculateStrength, calculateMomentum, calculateAcceleration, classifyStatus } = require("../engine/strengthEngine");
const { PAIRS } = require("../providers/providerInterface");
const { checkAlerts, getAlerts, addAlert, removeAlert } = require("../alerts/alertEngine");

const VALID_TIMEFRAMES = Object.keys(TIMEFRAMES);

function isValidTimeframe(tf) {
  return VALID_TIMEFRAMES.includes(tf);
}

// GET /api/strength/current?timeframe=1h
// Returns the latest stored snapshot per currency for a standard timeframe.
// Uses cached snapshots (Section 25 performance requirement) rather than
// recomputing from raw ticks on every request.
router.get("/strength/current", (req, res) => {
  const timeframe = req.query.timeframe || "1h";
  if (!isValidTimeframe(timeframe)) {
    return res.status(400).json({ error: `Invalid timeframe. Use one of: ${VALID_TIMEFRAMES.join(", ")}` });
  }
  const rows = db.getLatestSnapshotsForTimeframe(timeframe);
  if (rows.length === 0) {
    return res.status(202).json({ status: "pending", message: "No snapshots yet — the ingestion loop needs at least two fetch cycles to compute momentum. Check back shortly." });
  }
  const result = rows.map(r => ({
    currency: r.currency,
    strength: r.strength,
    momentum: r.momentum,
    acceleration: r.acceleration,
    status: classifyStatus(r.strength, r.momentum),
    pairsUsed: r.pairs_used,
    timestamp: r.timestamp,
    method: r.method,
  })).sort((a, b) => (b.strength ?? -Infinity) - (a.strength ?? -Infinity));
  res.json({ timeframe, generatedAt: rows[0]?.timestamp, currencies: result });
});

// GET /api/strength/multi-timeframe?currency=USD
// Returns a currency's strength across every standard timeframe at once —
// this is what section 6's "5m/15m/30m/1H/4H/1D" view needs.
router.get("/strength/multi-timeframe", (req, res) => {
  const currency = (req.query.currency || "").toUpperCase();
  if (!currency) return res.status(400).json({ error: "Provide ?currency=USD (or another tracked currency)." });

  const out = {};
  for (const tf of VALID_TIMEFRAMES) {
    const rows = db.getLatestSnapshotsForTimeframe(tf).filter(r => r.currency === currency);
    out[tf] = rows[0] ? { strength: rows[0].strength, momentum: rows[0].momentum, acceleration: rows[0].acceleration } : null;
  }
  res.json({ currency, timeframes: out });
});

// GET /api/strength/custom?minutes=90
// Section 15: custom timeframe. Computed on-demand (not cached, since any
// arbitrary value could be requested) directly from raw ticks.
router.get("/strength/custom", (req, res) => {
  const minutes = parseFloat(req.query.minutes);
  if (!minutes || minutes <= 0) {
    return res.status(400).json({ error: "Provide ?minutes=<positive number>" });
  }
  const lookbackMs = minutes * 60 * 1000;
  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() - lookbackMs).toISOString();

  const pairObservations = [];
  for (const symbol of PAIRS) {
    const latest = db.getLatestTick(symbol);
    const historical = db.getTickNear(symbol, cutoffIso);
    if (!latest || !historical) continue;
    pairObservations.push({ symbol, currentMid: latest.mid, historicalMid: historical.mid });
  }

  if (pairObservations.length === 0) {
    return res.json({ status: "insufficient_data", message: "Insufficient historical data for this timeframe yet.", minutes });
  }

  const result = calculateStrength(pairObservations);
  const currencies = Object.entries(result).map(([currency, d]) => ({
    currency, strength: d.strength, pairsUsed: d.pairsUsed,
  })).sort((a, b) => (b.strength ?? -Infinity) - (a.strength ?? -Infinity));

  res.json({ minutes, generatedAt: nowIso, currencies, note: "Custom timeframe strength only — momentum/acceleration require standard timeframe snapshots." });
});

// GET /api/strength/history?currency=USD&timeframe=1h&hours=24
router.get("/strength/history", (req, res) => {
  const currency = (req.query.currency || "").toUpperCase();
  const timeframe = req.query.timeframe || "1h";
  const hours = parseFloat(req.query.hours) || 24;
  if (!currency) return res.status(400).json({ error: "Provide ?currency=USD" });
  if (!isValidTimeframe(timeframe)) return res.status(400).json({ error: `Invalid timeframe. Use one of: ${VALID_TIMEFRAMES.join(", ")}` });

  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows = db.getSnapshotHistory(currency, timeframe, sinceIso);
  res.json({
    currency, timeframe, hours,
    points: rows.map(r => ({ timestamp: r.timestamp, strength: r.strength, momentum: r.momentum, acceleration: r.acceleration })),
  });
});

// GET /api/matrix?timeframe=1h
// Pairwise strength differential matrix (Section 10).
router.get("/matrix", (req, res) => {
  const timeframe = req.query.timeframe || "1h";
  if (!isValidTimeframe(timeframe)) return res.status(400).json({ error: `Invalid timeframe. Use one of: ${VALID_TIMEFRAMES.join(", ")}` });

  const rows = db.getLatestSnapshotsForTimeframe(timeframe);
  const byCurrency = Object.fromEntries(rows.map(r => [r.currency, r.strength]));
  const currencies = Object.keys(byCurrency);

  const matrix = {};
  for (const a of currencies) {
    matrix[a] = {};
    for (const b of currencies) {
      if (a === b) { matrix[a][b] = null; continue; }
      if (byCurrency[a] === null || byCurrency[b] === null) { matrix[a][b] = null; continue; }
      matrix[a][b] = +(byCurrency[a] - byCurrency[b]).toFixed(3);
    }
  }
  res.json({ timeframe, currencies, matrix });
});

// GET /api/strong-weak?timeframe=1h
router.get("/strong-weak", (req, res) => {
  const timeframe = req.query.timeframe || "1h";
  const rows = db.getLatestSnapshotsForTimeframe(timeframe)
    .filter(r => r.strength !== null)
    .sort((a, b) => b.strength - a.strength);

  if (rows.length < 2) {
    return res.json({ status: "insufficient_data" });
  }
  const strongest = rows.slice(0, 2).map(r => r.currency);
  const weakest = rows.slice(-2).map(r => r.currency);
  const diff = rows[0].strength - rows[rows.length - 1].strength;

  res.json({
    timeframe,
    strongest,
    weakest,
    largestDifferential: {
      pair: [rows[0].currency, rows[rows.length - 1].currency],
      value: +diff.toFixed(3),
      note: "Large relative strength differential detected. This is descriptive information, not a trading recommendation.",
    },
  });
});

// GET /api/pair-analysis?symbol=EUR/USD&timeframe=1h
router.get("/pair-analysis", (req, res) => {
  const symbol = req.query.symbol;
  const timeframe = req.query.timeframe || "1h";
  if (!symbol || !PAIRS.includes(symbol)) {
    return res.status(400).json({ error: `Provide ?symbol= one of: ${PAIRS.join(", ")}` });
  }
  const [base, quote] = symbol.split("/");
  const latest = db.getLatestTick(symbol);
  if (!latest) return res.status(202).json({ status: "pending", message: "No price data yet for this pair." });

  const changes = {};
  for (const [key, ms] of Object.entries(TIMEFRAMES)) {
    const hist = db.getTickNear(symbol, new Date(Date.now() - ms).toISOString());
    changes[key] = hist ? +(((latest.mid - hist.mid) / hist.mid) * 100).toFixed(4) : null;
  }

  const snapshots = db.getLatestSnapshotsForTimeframe(timeframe);
  const baseSnap = snapshots.find(s => s.currency === base);
  const quoteSnap = snapshots.find(s => s.currency === quote);

  res.json({
    symbol,
    currentPrice: latest.mid,
    changes,
    baseStrength: baseSnap ? baseSnap.strength : null,
    quoteStrength: quoteSnap ? quoteSnap.strength : null,
    baseMomentum: baseSnap ? baseSnap.momentum : null,
    quoteMomentum: quoteSnap ? quoteSnap.momentum : null,
    strengthDifferential: (baseSnap?.strength != null && quoteSnap?.strength != null)
      ? +(baseSnap.strength - quoteSnap.strength).toFixed(3) : null,
  });
});

// GET /api/market-status
router.get("/market-status", (req, res) => {
  res.json(getDataStatus());
});

// Alerts (Section 18)
router.get("/alerts", (req, res) => res.json(getAlerts()));
router.post("/alerts", express.json(), (req, res) => {
  try {
    const alert = addAlert(req.body);
    res.json(alert);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.delete("/alerts/:id", (req, res) => {
  removeAlert(req.params.id);
  res.json({ status: "removed" });
});
router.get("/alerts/triggered", (req, res) => {
  res.json(checkAlerts());
});

module.exports = router;
