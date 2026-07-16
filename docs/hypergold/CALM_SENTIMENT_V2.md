# HyperGold Calm Sentiment v2

## Objective

Replace the raw-tick-driven intelligence presentation with a calm decision
layer that separates exact execution values from smoothed predictive context.
The collector remains realtime, while AUTO consumes only a persistent,
internally consistent stable decision.

The release remains:

- gold-only: Hyperliquid `xyz:GOLD` and Bybit `XAUUSD+`;
- decision support only, with no order execution;
- aggregate-only at the public boundary;
- independent from unrelated Hyperliquid software, databases, proxies, and
  private keys.

## Rollback checkpoint

- Commit:
  `023c85ddf2c5ebe052b078539fe7c14a4db483fc`
- Commit message:
  `chore: precalm sentiment rollback checkpoint`
- Annotated tag: `precalm-sentiment`
- GitHub Actions:
  `https://github.com/jack420xeppep-a11y/FundingPips-calc/actions/runs/29498094198`
- Baseline: 99 tests, production build, operations contracts, dependency
  audit, actionlint, and real production Chrome smoke passed.
- Production after checkpoint: intelligence and quote relay both reported
  `live`; database schema version remained `1`.

Rollback is performed with an explicit revert of the Calm Sentiment merge
commit followed by a push to `main`. If a full source rollback is required,
deploy the tree referenced by `precalm-sentiment`. Database v2 additions are
additive and must remain readable by the pre-Calm service; rollback must never
delete collected rows.

## Price architecture

Three prices have distinct responsibilities:

| Price | Source and cadence | Purpose |
| --- | --- | --- |
| `executionPrice` | exact Bybit MID, realtime | calculator entry, lots, TP/SL, ticket, `MARKET NOW` |
| `decisionReferencePrice` | 5-second rolling median followed by time-aware EMA | predictive features and stable decision context |
| `outcomeAnchorPrice` | exact Bybit MID when a stable decision is emitted | future-only outcome labeling and calibration |

The reference EMA uses a 45-second half-life. When the exact price remains more
than 0.12% away for ten seconds, a 10-second fast half-life is used until the
gap falls below 0.05%. A single price spike cannot re-anchor the model.

The strategy context identity contains normalized strategy settings, never a
live or smoothed price. Exact price movement therefore cannot reset decision
memory or reopen the browser EventSource.

## Cadence

```text
public market collection      realtime
normalized feature state      1 second
raw probability model         5 seconds
sentiment aggregation         15 seconds
stable decision evaluation    15 seconds
primary UI publication        state change or >=3 percentage-point delta
```

Raw candidates remain available to private outcome learning and aggregate
observability. They never directly drive the primary interface.

## Stable decision state machine

States:

```text
WARMING
NEUTRAL
WATCH_LONG
WATCH_SHORT
CONFIRMED_LONG
CONFIRMED_SHORT
COOLDOWN_LONG
COOLDOWN_SHORT
LOCKED_LONG
LOCKED_SHORT
STALE
```

The state machine uses a 45-second probability EWMA and at least two minutes of
bounded evidence. It is deterministic under a fake clock.

Market-only confirmation while maturity is below 20% requires:

- target-path probability at least 65%;
- at least 18 percentage points over the opposite path;
- confidence at least 60%;
- `NEITHER` is not the largest path;
- at least 90 seconds of persistence.

Combined confirmation after sufficient wallet maturity requires:

- target-path probability at least 60%;
- at least 15 percentage points over the opposite path;
- confidence at least 55%;
- at least 60 seconds of persistence.

A confirmed direction switches only after 120 seconds of opposite evidence,
at least a 20-point advantage, and a ten-minute cooldown. A bounded emergency
override additionally requires 75% target probability, 75% confidence, aligned
momentum/flow/OI, and 30 seconds of persistence.

## Atomic public decision

Direction, paired paths, probability labels, confidence, sentiment, reasons,
and timing come from one immutable stable decision:

```text
state
fpDirection / bybitDirection
probabilities: DOWN / UP / NEITHER
confidence / edge / source
stableSince / nextSwitchAllowedAt
decisionReferencePrice / outcomeAnchorPrice
sentiment / reasons / freshness
```

The primary response never combines a stable heading with paths calculated for
the opposite raw candidate.

## Sentiment

Market sentiment is a signed score from -100 to +100:

```text
trend and momentum       26%
aggressive flow          22%
OI direction             15%
EMA book imbalance       12%
market regime            10%
basis and premium         8%
session alignment         7%
```

Whale sentiment is also signed:

```text
qualified positions      30%
net change 15m           25%
net change 1h            15%
new positions/closes     15%
unusual-size conviction  10%
entry cluster             5%
```

Whale state remains `WARMING`, with no numeric neutral placeholder, until at
least three qualified wallets and 10% wallet maturity exist. Wallet weight is
zero while data is warming or stale. Once qualified:

```text
walletWeight =
  min(0.55, 0.15 + 0.40 * maturity)
  * freshnessFactor
  * calibrationQuality
```

Tracked wallet tape deltas are realtime. REST discovery remains hourly, active
qualified positions reconcile every 15 minutes, cohorts score hourly, and full
requalification is daily.

## Frozen trade snapshot

`Зафиксировать сделку` creates a versioned immutable client snapshot containing
the exact entry, direction, lots, TP/SL, stable decision, sentiment, reasons,
and ticket. It survives React renders, SSE reconnects, theme/view changes, and
reloads until the prediction horizon expires.

While locked, the ticket never changes. A separate `MARKET NOW` value continues
to update and shows distance from the locked entry. Unlock enters `SYNCING` and
requires fresh stable confirmation before AUTO may apply again.

## Additive API contract

The existing aggregate fields remain during rollout. New bounded objects are
additive:

```text
decision
sentiment.market / sentiment.whale / sentiment.combined
priceContext
walletState
```

The public contract never returns addresses, individual positions, fills,
scores, P&L, seed membership, lifecycle records, filesystem paths, environment
values, or credentials.

## Persistence and operations

Schema version 2 adds only STRICT tables and indexes for bounded wallet position
samples and aggregate sentiment/decision history. Existing tables are not
deleted, renamed, or rewritten. Every new high-volume table has age retention,
row caps, parameterized writes, and WAL-safe cleanup.

Before the production migration, create a restrictive server-side SQLite
backup, verify disk space and integrity, and confirm that the service can
restart against the migrated database. Caddy configuration must preserve all
non-CalcPro domains.

## Release gates

- deterministic jitter replay does not flip the stable decision;
- exact price changes do not change strategy identity;
- weak or immature signals cannot enable AUTO;
- all stable decision fields use one direction;
- a zero-wallet state is `WARMING`, not 50%;
- public whale output contains no address;
- twenty or more SSE updates cannot mutate a lock;
- `MARKET NOW` changes while the locked ticket remains byte-identical;
- local and production Chrome smoke cover mobile/desktop, themes, reconnect,
  reload, lock/unlock, AUTO, and direct-socket absence;
- all existing calculator, quote relay, PWA, and operations tests remain green.
