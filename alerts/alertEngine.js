/**
 * ALERT FRAMEWORK
 * ---------------
 * Alerts are stored in-memory for now (simple, no extra DB table needed
 * yet) and checked on demand via GET /api/alerts/triggered, which the
 * frontend polls. This intentionally mirrors a notification-channel
 * abstraction similar to providers/ — `notify()` is the only function a
 * future email/Telegram/push channel would need to implement.
 */
const db = require("../db/db");

let alerts = []; // { id, type, currency, threshold, createdAt, lastState }
let nextId = 1;

const VALID_TYPES = [
  "strength_change",       // |strength - previous strength| > threshold
  "crosses_positive",      // strength goes from <0 to >=0
  "becomes_strongest",     // currency becomes the top-ranked currency
  "momentum_direction_change", // momentum sign flips
];

function addAlert({ type, currency, threshold, timeframe }) {
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid alert type. Use one of: ${VALID_TYPES.join(", ")}`);
  }
  const alert = {
    id: String(nextId++),
    type,
    currency: currency ? currency.toUpperCase() : null,
    threshold: threshold ?? null,
    timeframe: timeframe || "1h",
    createdAt: new Date().toISOString(),
    lastState: null, // used to detect transitions (e.g. sign changes)
  };
  alerts.push(alert);
  return alert;
}

function removeAlert(id) {
  alerts = alerts.filter(a => a.id !== id);
}

function getAlerts() {
  return alerts;
}

/**
 * Checks every configured alert against the latest snapshot data.
 * Returns any that fired since their last check. This is a browser-
 * notification-ready design (Section 18): the frontend calls this on
 * its polling cycle and shows a browser notification for anything
 * returned here. Swapping in email/Telegram later just means calling
 * a different `notify()` implementation with the same fired-alerts list.
 */
function checkAlerts() {
  const fired = [];

  for (const alert of alerts) {
    const rows = db.getLatestSnapshotsForTimeframe(alert.timeframe);

    if (alert.type === "strength_change" && alert.currency) {
      const row = rows.find(r => r.currency === alert.currency);
      if (!row || row.strength === null) continue;
      const prev = alert.lastState;
      if (prev !== null && Math.abs(row.strength - prev) > alert.threshold) {
        fired.push({ ...alert, message: `${alert.currency} strength changed by more than ${alert.threshold} (now ${row.strength.toFixed(2)}).` });
      }
      alert.lastState = row.strength;
    }

    if (alert.type === "crosses_positive" && alert.currency) {
      const row = rows.find(r => r.currency === alert.currency);
      if (!row || row.strength === null) continue;
      if (alert.lastState !== null && alert.lastState < 0 && row.strength >= 0) {
        fired.push({ ...alert, message: `${alert.currency} strength crossed from negative to positive (now ${row.strength.toFixed(2)}).` });
      }
      alert.lastState = row.strength;
    }

    if (alert.type === "becomes_strongest" && alert.currency) {
      const sorted = [...rows].filter(r => r.strength !== null).sort((a, b) => b.strength - a.strength);
      const isStrongest = sorted[0]?.currency === alert.currency;
      if (isStrongest && alert.lastState !== true) {
        fired.push({ ...alert, message: `${alert.currency} is now the strongest tracked currency.` });
      }
      alert.lastState = isStrongest;
    }

    if (alert.type === "momentum_direction_change" && alert.currency) {
      const row = rows.find(r => r.currency === alert.currency);
      if (!row || row.momentum === null) continue;
      const sign = Math.sign(row.momentum);
      if (alert.lastState !== null && alert.lastState !== 0 && sign !== 0 && sign !== alert.lastState) {
        fired.push({ ...alert, message: `${alert.currency} momentum direction changed.` });
      }
      alert.lastState = sign;
    }
  }

  return fired;
}

module.exports = { addAlert, removeAlert, getAlerts, checkAlerts, VALID_TYPES };
