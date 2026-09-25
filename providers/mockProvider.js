const { PAIRS } = require("./providerInterface");

// Realistic-ish starting mid prices, purely illustrative.
const BASE_PRICES = {
  "EUR/USD": 1.1712, "GBP/USD": 1.3421, "USD/JPY": 149.82, "USD/CHF": 0.8843,
  "USD/CAD": 1.3705, "AUD/USD": 0.6534, "NZD/USD": 0.5891, "EUR/GBP": 0.8727,
  "EUR/JPY": 175.44, "GBP/JPY": 201.05, "EUR/CHF": 1.0359, "AUD/JPY": 97.88,
  "NZD/JPY": 88.27, "EUR/AUD": 1.7925, "GBP/CHF": 1.1871, "EUR/CAD": 1.6055,
  "CAD/JPY": 109.31, "EUR/NZD": 1.9880,
};

// Simple in-memory random walk so consecutive calls drift realistically
// instead of jumping randomly every time.
let state = { ...BASE_PRICES };

function driftPrice(symbol) {
  const current = state[symbol];
  // Small percentage drift per tick, roughly in line with real FX tick sizes.
  const pctMove = (Math.random() - 0.5) * 0.0012; // up to ~0.06% per tick
  const next = current * (1 + pctMove);
  state[symbol] = next;
  return next;
}

async function getQuote(symbol) {
  if (!BASE_PRICES[symbol]) {
    throw new Error(`Mock provider has no data for symbol ${symbol}`);
  }
  const mid = driftPrice(symbol);
  const spread = mid * 0.0001; // tiny illustrative spread
  return {
    symbol,
    bid: +(mid - spread / 2).toFixed(6),
    ask: +(mid + spread / 2).toFixed(6),
    mid: +mid.toFixed(6),
    timestamp: new Date().toISOString(),
    source: "mock",
    isMock: true,
  };
}

async function getAllQuotes() {
  const out = [];
  for (const symbol of PAIRS) {
    out.push(await getQuote(symbol));
  }
  return out;
}

module.exports = { getQuote, getAllQuotes, name: "mock" };
