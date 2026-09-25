const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = path.join(DB_DIR, "fx.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// --- Schema ---
// ticks: raw price observations, one row per symbol per fetch cycle.
db.exec(`
  CREATE TABLE IF NOT EXISTS ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    symbol TEXT NOT NULL,
    bid REAL,
    ask REAL,
    mid REAL NOT NULL,
    source TEXT NOT NULL,
    is_mock INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time ON ticks(symbol, timestamp);
`);

// strength_snapshots: calculated currency strength/momentum/acceleration,
// saved periodically so historical charts don't require recomputing from
// raw ticks every time (see Section 25 performance requirement).
db.exec(`
  CREATE TABLE IF NOT EXISTS strength_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    currency TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    strength REAL NOT NULL,
    momentum REAL,
    acceleration REAL,
    pairs_used INTEGER NOT NULL,
    method TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_cur_tf_time ON strength_snapshots(currency, timeframe, timestamp);
`);

// --- Retention: don't keep raw ticks forever (Section 22 requirement) ---
// Ticks older than 8 days are pruned on each ingestion cycle; snapshots
// (much smaller, one row per currency per timeframe per cycle) are kept
// for 90 days. Adjust these to your own storage/backtesting needs.
const TICK_RETENTION_DAYS = 8;
const SNAPSHOT_RETENTION_DAYS = 90;

function pruneOldData() {
  const tickCutoff = new Date(Date.now() - TICK_RETENTION_DAYS * 86400000).toISOString();
  const snapCutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 86400000).toISOString();
  db.prepare("DELETE FROM ticks WHERE timestamp < ?").run(tickCutoff);
  db.prepare("DELETE FROM strength_snapshots WHERE timestamp < ?").run(snapCutoff);
}

function insertTick(quote) {
  db.prepare(`
    INSERT INTO ticks (timestamp, symbol, bid, ask, mid, source, is_mock)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(quote.timestamp, quote.symbol, quote.bid, quote.ask, quote.mid, quote.source, quote.isMock ? 1 : 0);
}

function insertSnapshot(row) {
  db.prepare(`
    INSERT INTO strength_snapshots (timestamp, currency, timeframe, strength, momentum, acceleration, pairs_used, method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.timestamp, row.currency, row.timeframe, row.strength, row.momentum ?? null, row.acceleration ?? null, row.pairsUsed, row.method);
}

// Latest tick for a symbol (used for "current price").
function getLatestTick(symbol) {
  return db.prepare(`
    SELECT * FROM ticks WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1
  `).get(symbol);
}

// The tick closest to (but not after) a given point in the past — this is
// how "historical_price" in the strength formula is resolved for a given
// timeframe lookback (see engine/strengthEngine.js).
function getTickNear(symbol, beforeIso) {
  return db.prepare(`
    SELECT * FROM ticks WHERE symbol = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1
  `).get(symbol, beforeIso);
}

function getAllLatestTicks() {
  return db.prepare(`
    SELECT t.* FROM ticks t
    INNER JOIN (
      SELECT symbol, MAX(timestamp) AS max_ts FROM ticks GROUP BY symbol
    ) latest ON t.symbol = latest.symbol AND t.timestamp = latest.max_ts
  `).all();
}

function getSnapshotHistory(currency, timeframe, sinceIso) {
  return db.prepare(`
    SELECT * FROM strength_snapshots
    WHERE currency = ? AND timeframe = ? AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(currency, timeframe, sinceIso);
}

function getLatestSnapshotsForTimeframe(timeframe) {
  return db.prepare(`
    SELECT s.* FROM strength_snapshots s
    INNER JOIN (
      SELECT currency, MAX(timestamp) AS max_ts FROM strength_snapshots
      WHERE timeframe = ? GROUP BY currency
    ) latest ON s.currency = latest.currency AND s.timestamp = latest.max_ts
    WHERE s.timeframe = ?
  `).all(timeframe, timeframe);
}

// Previous snapshot before a given timestamp, for momentum/acceleration diffing.
function getPreviousSnapshot(currency, timeframe, beforeIso) {
  return db.prepare(`
    SELECT * FROM strength_snapshots
    WHERE currency = ? AND timeframe = ? AND timestamp < ?
    ORDER BY timestamp DESC LIMIT 1
  `).get(currency, timeframe, beforeIso);
}

module.exports = {
  db, pruneOldData, insertTick, insertSnapshot,
  getLatestTick, getTickNear, getAllLatestTicks,
  getSnapshotHistory, getLatestSnapshotsForTimeframe, getPreviousSnapshot,
};
