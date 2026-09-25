# FX Strength Terminal

A decision-support Forex currency strength, momentum, and acceleration
analysis system. **It does not trade, place orders, or predict future
prices.** It calculates and displays objective, currently-observed market
information for you to combine with your own analysis.

---

## What I actually verified before giving you this

I ran this end-to-end in my build environment using the mock data
provider: installed dependencies, ran the full engine test suite (15
tests, all passing — including the orientation logic you specifically
asked to be tested carefully), started the server, and hit every API
endpoint (current strength, custom timeframe, pair analysis, matrix,
alerts) and confirmed real computed values came back correctly, including
correct "pending"/"insufficient data" responses when history genuinely
isn't old enough yet — it does not fabricate values to fill gaps.

**What I could not test:** the Twelve Data live-provider adapter (no
network access to external APIs from my build environment), and the
Docker build itself (same restriction). Both should work as written, but
verify them yourself after setup — instructions for both are below.

---

## Quick start (mock data, no API key needed)

```bash
npm install
cp .env.example .env
npm test        # run the engine test suite
npm start        # starts the server with simulated price data
```

Open `http://localhost:3000`. You'll see the dashboard immediately, but
give it a few minutes: shorter timeframes (5m) need 5 minutes of
accumulated history to show a real value, longer ones (1D) need a full
day. This is intentional — the system refuses to fabricate a "1 day
change" from 30 seconds of data. Use the **CUSTOM** timeframe with a
small number of minutes to see real computed output immediately.

---

## Connecting a real live data provider

1. Sign up for a free API key at [twelvedata.com](https://twelvedata.com/).
2. In `.env`, set:
   ```
   DATA_PROVIDER=twelvedata
   TWELVEDATA_API_KEY=your_key_here
   ```
3. Restart the server.

Check the terminal logs after restarting — if you see `[fetch] Failed to
read feed` or similar errors, it's almost always the free tier's rate
limit. Increase `FETCH_INTERVAL_SECONDS` in `.env` accordingly (their
dashboard shows your current plan's per-minute quota).

**Adding a different provider entirely:** implement `getQuote()` and
`getAllQuotes()` matching the shape documented in
`providers/providerInterface.js`, save it as a new file in `providers/`,
and register it in `providers/index.js`. Nothing else in the system needs
to change — this is the "provider abstraction" your spec asked for.

---

## The currency strength mathematics (Section 4–5, in full)

This is the part that matters most, so it's documented three times: in
prose here, in comments in `engine/strengthEngine.js`, and enforced by
the tests in `tests/strengthEngine.test.js`.

**Step 1 — pair return:**
```
return = ((current_mid - historical_mid) / historical_mid) * 100
```

**Step 2 — orientation-aware contribution:** a pair's return describes a
*relationship*, not one currency. For pair BASE/QUOTE with return `r`:
```
contribution(BASE)  += r
contribution(QUOTE) += -r
```

**Step 3 — aggregation across multiple pairs:** each currency is tracked
across several pairs (USD across 7, for example). Naively averaging risks
distortion from one outlier pair. This system uses a **trimmed mean**
(drops the single highest and lowest contribution) when 5+ pairs
contribute, and a plain mean below that — documented as a deliberate,
swappable choice, not the only valid one.

**Step 4 — normalization:** raw averaged contributions aren't comparable
across currencies or across calm vs. volatile days. This system converts
each currency's raw contribution into a **cross-sectional z-score**
relative to the other 7 currencies at that same moment:
```
z(currency) = (raw(currency) - mean(all raw values)) / stddev(all raw values)
```
This is a standard approach in currency-strength-meter literature — it
always expresses "how strong relative to the others, right now," not
against a fixed absolute scale.

**Momentum** = strength(now) − strength(previous snapshot) — a first
difference, describing rate of change, not a forecast.

**Acceleration** = momentum(now) − momentum(previous snapshot) — a
second difference, same caveat.

**Missing data:** a currency with zero valid contributing pairs gets
`null`, never a fabricated `0` (which would falsely claim "neutral").

---

## Architecture decisions I made (per your Section 32 instruction)

These change the architecture from what you suggested, so flagging them
explicitly rather than silently substituting:

| Your suggestion | What I built | Why |
|---|---|---|
| PostgreSQL + Redis | SQLite (single file) | No separate DB/cache server to run — the whole app is one process. Fully sufficient at this data volume. Swap later if you outgrow it. |
| React/Next.js/TypeScript frontend | Vanilla HTML/CSS/JS | Simpler to deploy and modify without a build step; the engine is fully decoupled from it either way (Section 21's requirement). |
| WebSocket streaming | REST polling (configurable interval) | The realistic free-tier data providers here are REST, not streaming. The provider abstraction means swapping in a WebSocket-based provider later doesn't require touching the engine, API, or frontend. |

---

## Project structure

```
providers/       Data provider abstraction (mock + Twelve Data adapters)
engine/           strengthEngine.js (the math), ingest.js (fetch → store → compute loop)
db/               SQLite schema and queries
routes/           REST API endpoints
alerts/           Alert rule engine
public/           Dashboard frontend
tests/            Engine unit tests (run with `npm test`)
```

## API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/strength/current?timeframe=1h` | Latest strength/momentum/acceleration per currency |
| `GET /api/strength/multi-timeframe?currency=USD` | One currency across all standard timeframes |
| `GET /api/strength/custom?minutes=90` | Strength for any custom lookback |
| `GET /api/strength/history?currency=USD&timeframe=1h&hours=24` | Time series for charting |
| `GET /api/matrix?timeframe=1h` | Pairwise strength differential matrix |
| `GET /api/strong-weak?timeframe=1h` | Strongest/weakest currencies + largest differential |
| `GET /api/pair-analysis?symbol=EUR/USD&timeframe=1h` | Full breakdown for one pair |
| `GET /api/market-status` | LIVE/DELAYED/STALE/OFFLINE + last update time |
| `GET /api/alerts`, `POST /api/alerts`, `DELETE /api/alerts/:id` | Alert configuration |
| `GET /api/alerts/triggered` | Alerts that have fired (poll this from the frontend) |

## Deploying

**Docker (recommended for a VPS):**
```bash
docker compose up -d --build
```

**Or any Node host** (Render, Railway, a VPS with pm2): same as the
currency-news-reader project from earlier — `npm install && npm start`,
respecting `process.env.PORT`.

Set `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` in `.env` before deploying
this publicly, per Section 24 — without them, anyone with the URL can see
your dashboard and hit your API.

## What's deliberately not built yet (Section 29)

Economic calendar, news sentiment, session detection, volume analysis,
Telegram/email alerts, user accounts, and backtesting are not implemented.
The architecture supports adding each without restructuring: a new
provider for economic calendar data, a new alert notification channel
implementing the same shape as browser notifications, and a new
`backtest.js` module reading directly from the `strength_snapshots` table
that already accumulates the history needed for it.
