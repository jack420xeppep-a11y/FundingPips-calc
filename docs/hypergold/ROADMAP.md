# HyperGold Intelligence v1 Roadmap

## Mission

Build a production-grade, gold-only decision-support layer for CalcPro. The
service observes Hyperliquid `xyz:GOLD`, the existing Bybit `XAUUSD+` relay, and
a rotating population of directional gold traders. It estimates which physical
price path is more likely to happen first for the current CalcPro setup:

- down: Bybit TP / FundingPips SL;
- up: Bybit SL / FundingPips TP;
- neither barrier inside the configured horizon.

The intelligence layer never places an order and never uses a private key.
`AUTO` may change only the displayed FundingPips direction in CalcPro.

## Fixed scope

- First release instrument: `XAUUSD` only.
- Hyperliquid market: `xyz:GOLD`.
- Bybit market: `XAUUSD+` from the existing CalcPro Quote Relay.
- No proxies, execution keys, commissions, or spread model.
- No shared database or runtime dependency on `/root/hyperx` or
  `/root/hypercopyx6900`.
- Existing gold addresses may be imported only as low-confidence seeds and
  must be re-observed and rescored by this service.

## Rollback checkpoint

- Commit: `3b1cadafe867fd78869d1526da61150e0e0d95c3`
- Annotated tag: `prehypergold`
- GitHub Actions run:
  `https://github.com/jack420xeppep-a11y/FundingPips-calc/actions/runs/29487167152`
- Baseline: 33 tests passed, production build passed, operations validation
  passed, dependency audit reported zero vulnerabilities.

## Calm Sentiment v2 checkpoint

The second production-safe checkpoint was created before changing the current
HyperGold behavior:

- Commit: `023c85ddf2c5ebe052b078539fe7c14a4db483fc`
- Tag: `precalm-sentiment`
- Workflow:
  `https://github.com/jack420xeppep-a11y/FundingPips-calc/actions/runs/29498094198`
- Baseline: 99 tests, build, operations contracts, dependency audit,
  actionlint, and real production Chrome smoke passed.
- Production intelligence and quote relay both reported `live` after the
  checkpoint deployment.

The Calm Sentiment architecture, compatibility contract, and rollback rules
are defined in `docs/hypergold/CALM_SENTIMENT_V2.md`.

Implementation status:

- execution/decision/outcome prices separated;
- bounded market and aggregate whale sentiment implemented;
- durable 15-second decision state machine implemented;
- complete versioned frozen trade snapshots implemented;
- Calm Sentiment desktop/mobile UI implemented and Chrome-smoked;
- additive schema v2, predeploy SQLite backup, integrity, disk, retention, and
  aggregate observability gates implemented.

## Architecture boundary

```text
Hyperliquid public WS        Existing Bybit quote relay
trades/bbo/book/context      XAUUSD+ bid/ask/mid
          |                           |
          v                           v
   CalcPro Gold Intelligence service (127.0.0.1:8788)
   - bounded collectors
   - rotating SQLite/WAL database
   - candidate observer
   - episode/cohort engine
   - outcome/calibration engine
   - aggregate snapshot + SSE API
          |
          v
      Caddy same-origin routes
          |
          v
   React HL Intelligence OFF/AUTO
```

Production data lives outside release directories so deploys cannot delete it:

```text
/var/lib/calcpro-intelligence/
  hypergold.sqlite
  seed-wallets.json        # optional, server-only, never committed
```

## Data retention and capacity

The database stores normalized numeric rows, not repeated upstream JSON.

| Data | Retention | Additional bound |
| --- | ---: | ---: |
| raw gold trades | 7 days | 1,000,000 rows |
| sampled market state | 30 days | 250,000 rows |
| wallet fills | 90 days | 750,000 rows |
| reconstructed episodes | 365 days | 250,000 rows |
| model predictions/outcomes | 180 days | 300,000 rows |
| lifecycle history | 365 days | 250,000 rows |
| active candidates | current | 5,000 wallets |

Cleanup runs daily with WAL checkpointing and incremental vacuum. Health output
reports page count, WAL size, row counts, last cleanup, and retention failures.
The service enters degraded mode before unbounded writes are allowed.

## Delivery phases

### Phase 1 — Independent gold market collector

- Subscribe to `trades`, `bbo`, `l2Book`, `activeAssetCtx`, and 1-minute
  candles for `xyz:GOLD`.
- Validate and deduplicate every message.
- Track aggressive flow, BBO, depth imbalance, mark/oracle, OI, funding,
  premium, volatility, momentum, and session.
- Read Bybit `XAUUSD+` from the loopback quote relay and calculate basis.
- Bound all in-memory queues and reconnect with capped exponential backoff.

Required commit:
`feat(intelligence): add independent xyz gold market collector`

### Phase 2 — Rotating gold wallet database

- Discover buyer and seller addresses from the gold tape.
- Maintain cheap counters before any expensive history request.
- Create the independent SQLite schema, lifecycle history, retention jobs,
  server-only seed import, and database health metrics.
- Never expose raw addresses through the public API.

Required commit:
`feat(intelligence): add rotating gold wallet database`

### Phase 3 — Episode reconstruction and classification

- Load `userFillsByTime` only for promising candidates.
- Preserve `startPosition`, `dir`, `crossed`, `oid`, `tid`, timestamps, side,
  size, price, and closed P&L.
- Query `clearinghouseState` with `dex: "xyz"` for the current gold position.
- Reconstruct adds, reductions, closes, and flips exactly around zero.
- Calculate holding time, MFE, MAE, captured movement, realized P&L,
  aggressiveness, and behavioural periodicity.
- Exclude market makers, bots, and unsuitable scalpers using multiple
  independent signals.

Required commit:
`feat(intelligence): reconstruct and classify gold trading episodes`

### Phase 4 — Rotating cohorts

- Implement lifecycle:
  `DISCOVERED -> OBSERVED -> QUALIFIED -> ACTIVE_COHORT -> PROBATION -> RETIRED`.
- Preserve every transition and reason.
- Build overlapping cohorts for side, session, regime, target band, intraday
  horizon, and unusual size.
- Score with profit factor, Sharpe, Wilson lower bound, recency EWMA,
  anti-luck, concentration, and side-specific quality.
- Refresh candidate/cohort scores hourly and fully requalify daily.
- Apply hysteresis so membership does not oscillate.

Required commit:
`feat(intelligence): build rotating gold trader cohorts`

### Phase 5 — Market regime and prediction outcomes

- Build the immediate market-only probability model.
- Label predictions from the future Bybit MID path, never Hyperliquid price.
- Record both direction counterfactuals without future leakage.
- Track TP-first hit rate, Brier score, calibration buckets, side/session
  breakdowns, and model maturity.
- Detect trend, breakout, reversal, and range regimes.

Required commit:
`feat(intelligence): add market regime and prediction outcomes`

### Phase 6 — Phase-aware probability engine

- Combine market and wallet layers gradually as verified wallet evidence grows.
- Weight wallets by quality, regime match, target match, recency, unusual
  position size, and independence.
- Return calibrated up/down/neither probabilities, confidence, horizon,
  maturity, cohort size, reason codes, and data freshness.
- Calculate phase-aware expected-value guidance for:
  `transfer-to-bybit`, `transfer-to-fundingpips`, and `best-expected-value`.
- Keep `NO EDGE` as a first-class result.

Required commit:
`feat(intelligence): add phase-aware gold probability engine`

### Phase 7 — CalcPro UI integration

- Add `HL Intelligence OFF/AUTO` near the direction control.
- Preserve the selected Linear Precision Fintech design and both themes.
- In `AUTO`, apply only stable and eligible recommendations.
- Show the paired path probabilities, confidence, horizon, cohort count,
  market/wallet/combined signals, maturity, freshness, and concise reasons.
- Freeze automatic direction changes after the user copies or explicitly locks
  the setup; require an explicit unlock.
- Preserve manual calculation in warming, stale, degraded, and error states.
- Keep mobile Quick Mode compact.

Required commit:
`feat(ui): add hl intelligence auto direction`

### Phase 8 — Production operations

- Add a dedicated hardened systemd service.
- Add restricted deploy paths/commands and Caddy same-origin routes.
- Ship structured logs and health checks.
- Update GitHub Actions release assembly, deployment, and production
  verification.
- Provision the optional seed file without committing its addresses.

Required commit:
`ops: deploy calcpro gold intelligence service`

## Public contract

Only aggregate state is public:

- service/market/wallet/model status and freshness;
- probabilities and recommendation;
- maturity, confidence, horizon, cohort count;
- aggregate market and wallet signals;
- reason codes and phase-aware expected-value summaries;
- bounded service/database health.

The following must never be returned:

- wallet addresses or seed lists;
- individual wallet weights, fills, positions, or P&L;
- private lifecycle records;
- environment values, filesystem paths, or credentials.

## Release gates

- Unit, integration, database migration/retention, reconnect/backpressure,
  prediction/outcome, lifecycle, API security, and browser tests pass.
- Existing calculator tests remain green.
- Production build and dependency audit pass.
- Browser QA covers desktop and mobile, both themes, OFF/AUTO, stale/degraded,
  copy lock, unlock, instrument switching, and no page overflow.
- Production health reports fresh Hyperliquid and Bybit inputs, bounded
  database size, clean service logs, and no secret exposure.
- Final merge to `main` is explicit and the deploy is verified in a real
  production browser before completion is declared.
