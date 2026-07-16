# HyperGold Implementation Sources

All external integration decisions use official documentation or live
read-only responses from the official public APIs.

## Hyperliquid

- WebSocket endpoint and reconnect requirement:
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- WebSocket subscriptions and payload types:
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- Info endpoint, `userFills`, `userFillsByTime`, and complete fill fields:
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- Perpetual metadata/asset contexts and `dex` semantics:
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
- REST and WebSocket rate limits:
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- L1 trade side ordering and historical data warning:
  https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/nodes/l1-data-schemas

Verified live on 2026-07-16:

- `metaAndAssetCtxs` with `dex: "xyz"` contains `xyz:GOLD`.
- `l2Book` accepts the prefixed coin `xyz:GOLD`.
- `trades` contains `users: [buyer, seller]`, `tid`, `hash`, and timestamp.
- `bbo`, `l2Book`, and `activeAssetCtx` provide the expected gold data.

## Node.js

- Node.js 22 `node:sqlite`:
  https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html

`DatabaseSync` was added in Node 22.5.0 and is available on the production
runtime (Node 22.22.3). The service uses prepared statements, strict tables,
WAL, bounded transactions, disabled extension loading, and a dedicated
non-public data directory.

## Existing CalcPro sources of truth

- `src/domain/calculator.js` remains the position and stage calculation source
  of truth.
- `server/quote-relay.js` remains the only Bybit TradFi upstream connection.
- Browser code consumes same-origin endpoints only.

