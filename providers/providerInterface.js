/**
 * DATA PROVIDER INTERFACE
 * ------------------------
 * Every provider (mock, twelvedata, or a future one you add) must return
 * data in this exact shape, so the rest of the system never needs to know
 * which provider is active. This is what makes the provider "swappable"
 * via the DATA_PROVIDER environment variable (see .env.example).
 *
 * getQuote(symbol) -> Promise<{
 *   symbol: "EUR/USD",
 *   bid: number,
 *   ask: number,
 *   mid: number,
 *   timestamp: ISO8601 string,
 *   source: "mock" | "twelvedata" | ...,
 *   isMock: boolean            <-- MUST be true for any non-live data.
 * }>
 *
 * A provider that cannot reach live data for a symbol should throw an
 * Error rather than return fabricated numbers labeled as live. The
 * ingestion loop (see ingest.js) treats a thrown error as "STALE/OFFLINE"
 * for that symbol, never as a silent zero or repeated last-known value
 * pretending to be fresh.
 */

const PAIRS = [
  "EUR/USD", "GBP/USD", "USD/JPY", "USD/CHF", "USD/CAD", "AUD/USD", "NZD/USD",
];
// These 18 pairs give every one of the 8 major currencies (USD, EUR, GBP,
// JPY, CHF, AUD, CAD, NZD) at least 3 contributing pairs each — verified
// by count, not assumed — which the strength engine needs to avoid
// single-pair distortion (see engine/strengthEngine.js for why).

module.exports = { PAIRS };
