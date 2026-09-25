require("dotenv").config();
const express = require("express");
const path = require("path");
const cron = require("node-cron");
const { runIngestionCycle } = require("./engine/ingest");
const strengthRoutes = require("./routes/strengthRoutes");

const app = express();
const PORT = process.env.PORT || 3000;
const FETCH_INTERVAL_SECONDS = parseInt(process.env.FETCH_INTERVAL_SECONDS || "30", 10);

// Optional basic auth (Section 24) — only active if both env vars are set.
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASS;
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme === "Basic" && encoded) {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (user === AUTH_USER && pass === AUTH_PASS) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="FX Strength Terminal"');
    res.status(401).send("Authentication required.");
  });
  console.log("Basic auth ENABLED for this deployment.");
} else {
  console.log("Basic auth disabled (BASIC_AUTH_USER/PASS not set) — fine for local use, set them before deploying publicly.");
}

app.use(express.static(path.join(__dirname, "public")));
app.use("/api", strengthRoutes);

app.listen(PORT, () => {
  console.log(`FX Strength Terminal running on port ${PORT}`);
  console.log(`Data provider: ${process.env.DATA_PROVIDER || "mock"}`);
});

// Run once immediately, then on the configured schedule. A currency's
// momentum needs at least two ingestion cycles of history to mean anything
// (see engine/ingest.js), so the dashboard will show "insufficient data"
// until the second cycle completes — this is expected, not a bug.
runIngestionCycle().catch(err => console.error("[ingest] Initial cycle failed:", err.message));

const cronExpression = `*/${Math.max(1, Math.round(FETCH_INTERVAL_SECONDS / 60))} * * * *`;
// node-cron's minimum granularity is 1 minute. For sub-minute intervals,
// use setInterval instead — cron can't express "every 30 seconds" natively.
if (FETCH_INTERVAL_SECONDS < 60) {
  setInterval(() => {
    runIngestionCycle().catch(err => console.error("[ingest] Cycle failed:", err.message));
  }, FETCH_INTERVAL_SECONDS * 1000);
  console.log(`Ingestion running every ${FETCH_INTERVAL_SECONDS}s via setInterval (sub-minute intervals bypass cron).`);
} else {
  cron.schedule(cronExpression, () => {
    runIngestionCycle().catch(err => console.error("[ingest] Cycle failed:", err.message));
  });
  console.log(`Ingestion scheduled: ${cronExpression}`);
}
