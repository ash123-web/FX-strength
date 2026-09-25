/**
 * CURRENCY STRENGTH ENGINE
 * ========================
 *
 * This is the mathematical core of the system. Everything else (API,
 * dashboard, alerts) just displays what this module computes. Documented
 * deliberately verbosely, since getting this wrong makes everything built
 * on top of it meaningless.
 *
 * --- Step 1: Pair return ---
 * For a currency pair BASE/QUOTE, the percentage return over a timeframe is:
 *
 *   return = ((current_mid - historical_mid) / historical_mid) * 100
 *
 * --- Step 2: Orientation-aware contribution ---
 * A pair's return does NOT describe one currency — it describes a
 * relationship. Per your spec's own examples:
 *
 *   EUR/USD return = -0.40%  ->  EUR contribution = -0.40, USD contribution = +0.40
 *   USD/JPY return = +0.60%  ->  USD contribution = +0.60, JPY contribution = -0.60
 *
 * Formally: for pair BASE/QUOTE with return r,
 *   contribution(BASE)  += r
 *   contribution(QUOTE)  += -r
 *
 * --- Step 3: Aggregation across multiple pairs (why this matters) ---
 * A currency typically appears in several pairs (USD appears in 7 of the
 * 18 tracked pairs, for example). Naively averaging is a real risk your
 * spec calls out — e.g. if 6 of USD's 7 pairs are flat and one moves
 * sharply, a raw mean can be skewed by that one pair. This engine uses a
 * TRIMMED MEAN when there are 5+ contributing pairs: it drops the single
 * highest and single lowest contribution before averaging, reducing the
 * influence of one outlier pair (e.g. a low-liquidity cross moving on
 * thin volume). Below 5 pairs, a trimmed mean would discard too much
 * data, so a plain mean is used instead. This is a deliberate, documented
 * choice — swap `aggregateContributions()` below if you want a different
 * method (e.g. liquidity-weighted, once you have real volume data).
 *
 * --- Step 4: Normalization (raw % change -> comparable score) ---
 * A raw averaged % contribution isn't comparable across currencies or
 * across calm vs volatile market days — a "+0.3" contribution means
 * something different on a quiet day than a wild one. This engine
 * converts each currency's raw contribution into a Z-SCORE relative to
 * the other 7 currencies at that same timestamp:
 *
 *   z(currency) = (raw(currency) - mean(all 8 raw values))
 *                 / stddev(all 8 raw values)
 *
 * This is documented here as a CROSS-SECTIONAL Z-SCORE / composite
 * relative-strength index: it always describes each currency's strength
 * *relative to the other majors right now*, not against some absolute
 * fixed scale. That matches the spec's own request ("normalized so every
 * currency can be compared on the same scale") and is the standard
 * approach used in relative-strength / currency-strength-meter literature.
 *
 * --- Missing data / insufficient pairs ---
 * If a currency has zero valid contributing pairs for a timeframe (all
 * failed or are missing historical data), this engine returns null for
 * that currency rather than a fabricated 0 — 0 would falsely imply
 * "perfectly neutral," which is a claim, not an absence of data.
 */

function trimmedOrPlainMean(values) {
  if (values.length === 0) return null;
  if (values.length < 5) {
    return values.reduce((a, b) => a + b, 0) / values.length;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1); // drop lowest and highest
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

function computePairReturn(currentMid, historicalMid) {
  if (!historicalMid || historicalMid === 0) return null;
  return ((currentMid - historicalMid) / historicalMid) * 100;
}

/**
 * Given a list of { symbol, currentMid, historicalMid } for all tracked
 * pairs, compute the raw (pre-normalization) contribution for every
 * currency that appears in at least one pair.
 *
 * @returns { [currency]: { raw: number|null, pairsUsed: number } }
 */
function computeRawContributions(pairObservations) {
  const contributionsByCurrency = {}; // currency -> array of contribution values

  for (const obs of pairObservations) {
    const [base, quote] = obs.symbol.split("/");
    const r = computePairReturn(obs.currentMid, obs.historicalMid);
    if (r === null) continue; // missing/insufficient historical data for this pair — skip, don't fabricate

    (contributionsByCurrency[base] ??= []).push(r);
    (contributionsByCurrency[quote] ??= []).push(-r);
  }

  const result = {};
  for (const [currency, values] of Object.entries(contributionsByCurrency)) {
    result[currency] = {
      raw: trimmedOrPlainMean(values),
      pairsUsed: values.length,
    };
  }
  return result;
}

/**
 * Convert raw contributions into cross-sectional z-scores.
 * Currencies with null raw values (no data) stay null and are excluded
 * from the mean/stddev calculation so they don't distort other currencies.
 */
function normalizeToZScores(rawByCurrency) {
  const entries = Object.entries(rawByCurrency).filter(([, v]) => v.raw !== null);
  if (entries.length < 2) {
    // Can't compute a meaningful stddev with fewer than 2 data points.
    const out = {};
    for (const [cur, v] of Object.entries(rawByCurrency)) out[cur] = { ...v, strength: null };
    return out;
  }

  const values = entries.map(([, v]) => v.raw);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);

  const out = {};
  for (const [currency, v] of Object.entries(rawByCurrency)) {
    if (v.raw === null) {
      out[currency] = { ...v, strength: null };
    } else if (stddev === 0) {
      // All currencies moved identically (or only one had data) — no relative
      // difference to express. 0 is correct here, not a missing-data stand-in.
      out[currency] = { ...v, strength: 0 };
    } else {
      out[currency] = { ...v, strength: (v.raw - mean) / stddev };
    }
  }
  return out;
}

/**
 * Full pipeline: pair observations in, per-currency strength scores out.
 *
 * @param {Array<{symbol: string, currentMid: number, historicalMid: number}>} pairObservations
 * @returns {Object} { [currency]: { strength: number|null, raw: number|null, pairsUsed: number } }
 */
function calculateStrength(pairObservations) {
  const raw = computeRawContributions(pairObservations);
  return normalizeToZScores(raw);
}

/**
 * MOMENTUM: rate of change of strength itself.
 * momentum = strength(now) - strength(previous snapshot)
 * A simple first difference — documented as an approximation of a
 * derivative, not a prediction of future direction.
 */
function calculateMomentum(currentStrength, previousStrength) {
  if (currentStrength === null || previousStrength === null || previousStrength === undefined) return null;
  return currentStrength - previousStrength;
}

/**
 * ACCELERATION: rate of change of momentum itself (second difference).
 * acceleration = momentum(now) - momentum(previous snapshot)
 */
function calculateAcceleration(currentMomentum, previousMomentum) {
  if (currentMomentum === null || previousMomentum === null || previousMomentum === undefined) return null;
  return currentMomentum - previousMomentum;
}

/**
 * Neutral-language status classification. Deliberately avoids "good/bad"
 * or predictive language ("will rise") per the spec's explicit requirement.
 */
function classifyStatus(strength, momentum) {
  if (strength === null) return "INSUFFICIENT_DATA";
  if (momentum === null) return strength >= 0 ? "STRONG_RELATIVE_STRENGTH" : "WEAK_RELATIVE_STRENGTH";
  if (momentum > 0.05) return "STRENGTHENING";
  if (momentum < -0.05) return "WEAKENING";
  return "STEADY";
}

module.exports = {
  computePairReturn,
  trimmedOrPlainMean,
  computeRawContributions,
  normalizeToZScores,
  calculateStrength,
  calculateMomentum,
  calculateAcceleration,
  classifyStatus,
};
