const { getProvider } = require("../providers");
const db = require("../db/db");
const { calculateStrength, calculateMomentum, calculateAcceleration } = require("../engine/strengthEngine");
const { PAIRS } = require("../providers/providerInterface");

// Timeframe -> lookback in milliseconds. "Custom" is handled separately
// via the API (routes/strengthRoutes.js), since it needs a user-supplied value.
const TIMEFRAMES = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

// Tracks per-symbol fetch health so the dashboard can show LIVE/DELAYED/STALE/OFFLINE
// (Section 17 requirement) instead of silently computing from old data.
const dataStatus = {
  lastSuccessfulFetch: null,
  lastAttempt: null,
  failedSymbols: new Set(),
  providerName: null,
};

function getDataStatus() {
  if (!dataStatus.lastSuccessfulFetch) return { state: "OFFLINE", lastUpdate: null, provider: dataStatus.providerName };
  const ageMs = Date.now() - new Date(dataStatus.lastSuccessfulFetch).getTime();
  const intervalMs = (parseInt(process.env.FETCH_INTERVAL_SECONDS || "30", 10)) * 1000;
  let state = "LIVE";
  if (ageMs > intervalMs * 4) state = "STALE";
  else if (ageMs > intervalMs * 1.5) state = "DELAYED";
  return {
    state,
    lastUpdate: dataStatus.lastSuccessfulFetch,
    provider: dataStatus.providerName,
    failedSymbols: [...dataStatus.failedSymbols],
  };
}

/**
 * Compute strength for one timeframe using stored tick history, then diff
 * against the previous snapshot for momentum, and against the previous
 * momentum for acceleration.
 */
function computeAndStoreForTimeframe(timeframeKey, lookbackMs) {
  const now = new Date();
  const nowIso = now.toISOString();
  const historicalCutoffIso = new Date(now.getTime() - lookbackMs).toISOString();

  const pairObservations = [];
  for (const symbol of PAIRS) {
    const latest = db.getLatestTick(symbol);
    const historical = db.getTickNear(symbol, historicalCutoffIso);
    if (!latest || !historical) continue; // not enough history yet — skip, don't fabricate
    pairObservations.push({ symbol, currentMid: latest.mid, historicalMid: historical.mid });
  }

  const strengthResult = calculateStrength(pairObservations);

  for (const [currency, data] of Object.entries(strengthResult)) {
    const prevSnapshot = db.getPreviousSnapshot(currency, timeframeKey, nowIso);
    const momentum = calculateMomentum(data.strength, prevSnapshot ? prevSnapshot.strength : null);
    const acceleration = calculateAcceleration(momentum, prevSnapshot ? prevSnapshot.momentum : null);

    db.insertSnapshot({
      timestamp: nowIso,
      currency,
      timeframe: timeframeKey,
      strength: data.strength,
      momentum,
      acceleration,
      pairsUsed: data.pairsUsed,
      method: "zscore_trimmed_mean_v1",
    });
  }
}

async function runIngestionCycle() {
  const provider = getProvider();
  dataStatus.providerName = provider.name;
  dataStatus.lastAttempt = new Date().toISOString();

  let quotes = [];
  try {
    quotes = await provider.getAllQuotes();
    dataStatus.failedSymbols = new Set(PAIRS.filter(p => !quotes.find(q => q.symbol === p)));
  } catch (err) {
    console.error(`[ingest] Provider fetch failed entirely: ${err.message}`);
    dataStatus.failedSymbols = new Set(PAIRS);
    return; // nothing to store this cycle
  }

  for (const q of quotes) {
    db.insertTick(q);
  }
  if (quotes.length > 0) {
    dataStatus.lastSuccessfulFetch = new Date().toISOString();
  }

  // Recompute strength/momentum/acceleration for every standard timeframe.
  for (const [key, ms] of Object.entries(TIMEFRAMES)) {
    computeAndStoreForTimeframe(key, ms);
  }

  db.pruneOldData();
}

module.exports = { runIngestionCycle, getDataStatus, TIMEFRAMES };
