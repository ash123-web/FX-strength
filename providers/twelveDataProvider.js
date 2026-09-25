// Real live-data provider using Twelve Data (https://twelvedata.com/).
// Activated by setting DATA_PROVIDER=twelvedata and TWELVEDATA_API_KEY in .env.
//
// This is REST-based, not streaming — Twelve Data's WebSocket/streaming tier
// requires a paid plan. This adapter polls on the FETCH_INTERVAL_SECONDS
// schedule instead. If you later upgrade to a streaming plan, this is the
// file to replace with a WebSocket client — nothing else in the app needs
// to change, since everything else only talks to the provider interface.

const { PAIRS } = require("./providerInterface");

const API_KEY = process.env.TWELVEDATA_API_KEY;
const BASE_URL = "https://api.twelvedata.com";

function toApiSymbol(pair) {
  return pair.replace("/", "/"); // Twelve Data uses "EUR/USD" format already
}

async function getQuote(symbol) {
  if (!API_KEY) {
    throw new Error(
      "TWELVEDATA_API_KEY is not set. Add it to your .env file, or switch " +
      "DATA_PROVIDER back to 'mock' in .env to keep developing without a live feed."
    );
  }
  const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(toApiSymbol(symbol))}&apikey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data request failed for ${symbol}: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.status === "error" || !data.close) {
    throw new Error(`Twelve Data returned no usable quote for ${symbol}: ${JSON.stringify(data)}`);
  }

  const mid = parseFloat(data.close);
  // Twelve Data's free /quote endpoint doesn't always return a live bid/ask
  // spread — where it doesn't, we derive an illustrative spread from mid
  // rather than fabricate a precise one, and this is NOT marked isMock
  // (isMock only describes whether the underlying price is simulated).
  const bid = data.bid ? parseFloat(data.bid) : mid - mid * 0.00005;
  const ask = data.ask ? parseFloat(data.ask) : mid + mid * 0.00005;

  return {
    symbol,
    bid: +bid.toFixed(6),
    ask: +ask.toFixed(6),
    mid: +mid.toFixed(6),
    timestamp: new Date().toISOString(),
    source: "twelvedata",
    isMock: false,
  };
}

async function getAllQuotes() {
  // Twelve Data's free tier has a strict per-minute call limit — fetching
  // 18 symbols one by one on every cycle can exceed it fast. Their /quote
  // endpoint supports comma-separated symbols in one call, which we use here
  // to stay within typical free-tier limits. Check your plan's actual quota
  // and adjust FETCH_INTERVAL_SECONDS accordingly.
  if (!API_KEY) {
    throw new Error("TWELVEDATA_API_KEY is not set — cannot fetch live quotes.");
  }
  const symbolsParam = PAIRS.map(toApiSymbol).join(",");
  const url = `${BASE_URL}/quote?symbol=${encodeURIComponent(symbolsParam)}&apikey=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data batch request failed: HTTP ${res.status}`);
  }
  const data = await res.json();

  // Response shape is { "EUR/USD": {...}, "GBP/USD": {...}, ... } for multi-symbol requests.
  const out = [];
  for (const symbol of PAIRS) {
    const q = data[symbol];
    if (!q || q.status === "error" || !q.close) {
      // Skip and let the ingestion loop mark this symbol STALE — never fabricate.
      continue;
    }
    const mid = parseFloat(q.close);
    const bid = q.bid ? parseFloat(q.bid) : mid - mid * 0.00005;
    const ask = q.ask ? parseFloat(q.ask) : mid + mid * 0.00005;
    out.push({
      symbol,
      bid: +bid.toFixed(6),
      ask: +ask.toFixed(6),
      mid: +mid.toFixed(6),
      timestamp: new Date().toISOString(),
      source: "twelvedata",
      isMock: false,
    });
  }
  return out;
}

module.exports = { getQuote, getAllQuotes, name: "twelvedata" };
