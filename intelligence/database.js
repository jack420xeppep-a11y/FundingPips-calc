import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_SEED_FILE_BYTES = 256 * 1_024;
const MAX_SEED_ADDRESSES = 500;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

export const WALLET_STATUSES = Object.freeze([
  'DISCOVERED',
  'OBSERVED',
  'QUALIFIED',
  'ACTIVE_COHORT',
  'PROBATION',
  'RETIRED',
  'EXCLUDED',
]);

const STATUS_SET = new Set(WALLET_STATUSES);
const TRANSITIONS = Object.freeze({
  DISCOVERED: new Set(['OBSERVED', 'RETIRED', 'EXCLUDED']),
  OBSERVED: new Set(['QUALIFIED', 'RETIRED', 'EXCLUDED']),
  QUALIFIED: new Set(['ACTIVE_COHORT', 'PROBATION', 'RETIRED', 'EXCLUDED']),
  ACTIVE_COHORT: new Set(['PROBATION', 'RETIRED', 'EXCLUDED']),
  PROBATION: new Set(['ACTIVE_COHORT', 'RETIRED', 'EXCLUDED']),
  RETIRED: new Set(['OBSERVED']),
  EXCLUDED: new Set(['OBSERVED']),
});

const DEFAULT_RETENTION = Object.freeze({
  tradesMs: 7 * DAY_MS,
  marketSamplesMs: 30 * DAY_MS,
  fillsMs: 90 * DAY_MS,
  episodesMs: 365 * DAY_MS,
  predictionsMs: 180 * DAY_MS,
  lifecycleMs: 365 * DAY_MS,
  maxTrades: 1_000_000,
  maxMarketSamples: 250_000,
  maxFills: 750_000,
  maxEpisodes: 250_000,
  maxPredictions: 300_000,
  maxLifecycleEvents: 250_000,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS service_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS wallets (
    address TEXT PRIMARY KEY CHECK(length(address) = 42),
    status TEXT NOT NULL,
    exclusion_reason TEXT,
    seed INTEGER NOT NULL DEFAULT 0 CHECK(seed IN (0, 1)),
    trust REAL NOT NULL DEFAULT 0 CHECK(trust >= 0 AND trust <= 1),
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_trade_at INTEGER,
    next_review_at INTEGER,
    trade_count INTEGER NOT NULL DEFAULT 0,
    buy_count INTEGER NOT NULL DEFAULT 0,
    sell_count INTEGER NOT NULL DEFAULT 0,
    aggressive_count INTEGER NOT NULL DEFAULT 0,
    notional REAL NOT NULL DEFAULT 0,
    max_notional REAL NOT NULL DEFAULT 0,
    last_action TEXT,
    side_switch_count INTEGER NOT NULL DEFAULT 0,
    interval_count INTEGER NOT NULL DEFAULT 0,
    interval_mean_ms REAL NOT NULL DEFAULT 0,
    interval_m2 REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS wallet_lifecycle (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT NOT NULL,
    score REAL,
    at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS gold_trades (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    hash TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('A', 'B')),
    price REAL NOT NULL CHECK(price > 0),
    size REAL NOT NULL CHECK(size > 0),
    notional REAL NOT NULL CHECK(notional > 0),
    buyer TEXT NOT NULL CHECK(length(buyer) = 42),
    seller TEXT NOT NULL CHECK(length(seller) = 42),
    UNIQUE(timestamp, tid)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS market_samples (
    id INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    hyperliquid_mid REAL NOT NULL CHECK(hyperliquid_mid > 0),
    bybit_mid REAL NOT NULL CHECK(bybit_mid > 0),
    basis_bps REAL NOT NULL,
    aggressive_flow_5m REAL NOT NULL DEFAULT 0,
    aggressive_flow_15m REAL NOT NULL DEFAULT 0,
    aggressive_flow_60m REAL NOT NULL DEFAULT 0,
    book_imbalance REAL NOT NULL DEFAULT 0,
    momentum_5m_bps REAL NOT NULL DEFAULT 0,
    momentum_15m_bps REAL NOT NULL DEFAULT 0,
    volatility_bps REAL NOT NULL DEFAULT 0,
    oi_change_pct REAL NOT NULL DEFAULT 0,
    mark_price REAL,
    oracle_price REAL,
    open_interest REAL,
    funding REAL,
    premium REAL,
    session TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS wallet_fills (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    timestamp INTEGER NOT NULL,
    tid INTEGER NOT NULL,
    hash TEXT NOT NULL,
    oid INTEGER NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('A', 'B')),
    direction TEXT NOT NULL,
    price REAL NOT NULL CHECK(price > 0),
    size REAL NOT NULL CHECK(size > 0),
    start_position REAL NOT NULL,
    closed_pnl REAL NOT NULL,
    crossed INTEGER NOT NULL CHECK(crossed IN (0, 1)),
    fee REAL NOT NULL DEFAULT 0,
    UNIQUE(address, timestamp, tid)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    entry_price REAL NOT NULL CHECK(entry_price > 0),
    exit_price REAL,
    peak_size REAL NOT NULL CHECK(peak_size > 0),
    closed_pnl REAL NOT NULL DEFAULT 0,
    hold_ms INTEGER,
    mfe_bps REAL,
    mae_bps REAL,
    captured_bps REAL,
    fill_count INTEGER NOT NULL,
    aggressive_ratio REAL NOT NULL DEFAULT 0,
    session TEXT,
    regime TEXT,
    target_band TEXT,
    complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0, 1)),
    reconstructed_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS wallet_scores (
    address TEXT PRIMARY KEY REFERENCES wallets(address) ON DELETE CASCADE,
    calculated_at INTEGER NOT NULL,
    episode_count INTEGER NOT NULL,
    win_rate REAL NOT NULL,
    wilson_lower REAL NOT NULL,
    profit_factor REAL NOT NULL,
    sharpe REAL NOT NULL,
    ewma_quality REAL NOT NULL,
    anti_luck REAL NOT NULL,
    long_quality REAL NOT NULL,
    short_quality REAL NOT NULL,
    overall_score REAL NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS cohort_memberships (
    id INTEGER PRIMARY KEY,
    address TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
    cohort TEXT NOT NULL,
    score REAL NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    reason TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    entry_price REAL NOT NULL CHECK(entry_price > 0),
    up_barrier REAL NOT NULL CHECK(up_barrier > 0),
    down_barrier REAL NOT NULL CHECK(down_barrier > 0),
    fp_direction TEXT NOT NULL CHECK(fp_direction IN ('long', 'short')),
    stage TEXT NOT NULL,
    probability_up REAL NOT NULL,
    probability_down REAL NOT NULL,
    probability_neither REAL NOT NULL,
    market_probability REAL NOT NULL,
    wallet_probability REAL,
    combined_probability REAL NOT NULL,
    maturity REAL NOT NULL,
    outcome TEXT,
    outcome_at INTEGER,
    UNIQUE(fingerprint, created_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS model_metrics (
    bucket TEXT PRIMARY KEY,
    resolved_count INTEGER NOT NULL DEFAULT 0,
    brier_sum REAL NOT NULL DEFAULT 0,
    hit_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS gold_trades_timestamp_idx
    ON gold_trades(timestamp);
  CREATE INDEX IF NOT EXISTS gold_trades_buyer_idx
    ON gold_trades(buyer, timestamp);
  CREATE INDEX IF NOT EXISTS gold_trades_seller_idx
    ON gold_trades(seller, timestamp);
  CREATE INDEX IF NOT EXISTS wallets_status_review_idx
    ON wallets(status, next_review_at, last_seen_at);
  CREATE INDEX IF NOT EXISTS lifecycle_address_at_idx
    ON wallet_lifecycle(address, at);
  CREATE INDEX IF NOT EXISTS market_samples_timestamp_idx
    ON market_samples(timestamp);
  CREATE INDEX IF NOT EXISTS fills_address_timestamp_idx
    ON wallet_fills(address, timestamp);
  CREATE INDEX IF NOT EXISTS episodes_address_opened_idx
    ON episodes(address, opened_at);
  CREATE INDEX IF NOT EXISTS cohorts_active_idx
    ON cohort_memberships(cohort, ended_at, score);
  CREATE INDEX IF NOT EXISTS predictions_outcome_idx
    ON predictions(outcome, expires_at);
`;

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const isFiniteNumber = (value) => Number.isFinite(Number(value));

const validateAddress = (address) => (
  typeof address === 'string' && ADDRESS_PATTERN.test(address)
);

const normalizeAddress = (address) => {
  if (!validateAddress(address)) throw new Error('Invalid wallet address.');
  return address.toLowerCase();
};

const toBoolean = (value) => Boolean(Number(value));

const mapWallet = (row) => {
  if (!row) return null;
  return {
    address: row.address,
    status: row.status,
    exclusionReason: row.exclusion_reason,
    seed: toBoolean(row.seed),
    trust: row.trust,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastTradeAt: row.last_trade_at,
    nextReviewAt: row.next_review_at,
    tradeCount: row.trade_count,
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    aggressiveCount: row.aggressive_count,
    notional: row.notional,
    maxNotional: row.max_notional,
    lastAction: row.last_action,
    sideSwitchCount: row.side_switch_count,
    intervalCount: row.interval_count,
    intervalMeanMs: row.interval_mean_ms,
    intervalM2: row.interval_m2,
    updatedAt: row.updated_at,
  };
};

const validateRetention = (retention) => {
  const merged = { ...DEFAULT_RETENTION, ...retention };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Retention value ${key} must be a positive safe integer.`);
    }
  }
  return Object.freeze(merged);
};

const withTransaction = (database, operation) => {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
};

export function loadSeedAddresses(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 4_096) {
    throw new Error('Seed file path is invalid.');
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error('Seed path must be a regular file.');
  }
  if (file.size > MAX_SEED_FILE_BYTES) {
    throw new Error(`Seed file exceeds ${MAX_SEED_FILE_BYTES} bytes.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Seed file is not valid JSON.');
  }
  const candidates = Array.isArray(parsed) ? parsed : parsed?.addresses;
  if (!Array.isArray(candidates)) {
    throw new Error('Seed file must contain an addresses array.');
  }
  if (candidates.length > MAX_SEED_ADDRESSES) {
    throw new Error(`Seed file exceeds ${MAX_SEED_ADDRESSES} addresses.`);
  }

  return [...new Set(candidates.flatMap((address) => (
    validateAddress(address) ? [address.toLowerCase()] : []
  )))];
}

export function createIntelligenceDatabase({
  path,
  now = Date.now,
  retention: retentionOverrides = {},
} = {}) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 4_096) {
    throw new Error('Database path is required.');
  }
  const inMemory = path === ':memory:';
  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error('Database path must not be a symbolic link.');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const retention = validateRetention(retentionOverrides);
  const database = new DatabaseSync(path, {
    allowExtension: false,
    timeout: 5_000,
  });
  let closed = false;

  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA trusted_schema = OFF');
  if (!inMemory) {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = NORMAL');
    database.exec('PRAGMA wal_autocheckpoint = 1000');
  }
  database.exec(SCHEMA);
  database.prepare(
    'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)',
  ).run(now());
  if (!inMemory) chmodSync(path, 0o600);

  const insertWallet = database.prepare(`
    INSERT OR IGNORE INTO wallets (
      address, status, seed, trust, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, 'DISCOVERED', ?, ?, ?, ?, ?)
  `);
  const selectWallet = database.prepare('SELECT * FROM wallets WHERE address = ?');
  const insertLifecycle = database.prepare(`
    INSERT INTO wallet_lifecycle (
      address, from_status, to_status, reason, score, at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertTrade = database.prepare(`
    INSERT OR IGNORE INTO gold_trades (
      timestamp, tid, hash, side, price, size, notional, buyer, seller
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateWallet = database.prepare(`
    UPDATE wallets SET
      first_seen_at = ?,
      last_seen_at = ?,
      last_trade_at = ?,
      trade_count = ?,
      buy_count = ?,
      sell_count = ?,
      aggressive_count = ?,
      notional = ?,
      max_notional = ?,
      last_action = ?,
      side_switch_count = ?,
      interval_count = ?,
      interval_mean_ms = ?,
      interval_m2 = ?,
      updated_at = ?
    WHERE address = ?
  `);
  const markSeed = database.prepare(`
    UPDATE wallets
      SET seed = 1, trust = MAX(trust, 0.1), updated_at = ?
      WHERE address = ? AND seed = 0
  `);
  const transitionWalletStatement = database.prepare(`
    UPDATE wallets
      SET status = ?, exclusion_reason = ?, updated_at = ?
      WHERE address = ?
  `);
  const insertMarketSample = database.prepare(`
    INSERT INTO market_samples (
      timestamp, hyperliquid_mid, bybit_mid, basis_bps,
      aggressive_flow_5m, aggressive_flow_15m, aggressive_flow_60m,
      book_imbalance, momentum_5m_bps, momentum_15m_bps,
      volatility_bps, oi_change_pct, mark_price, oracle_price,
      open_interest, funding, premium, session
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ensureWallet = (address, {
    at,
    seed = false,
    reason = seed ? 'seed import' : 'gold tape discovery',
  }) => {
    const normalized = normalizeAddress(address);
    const result = insertWallet.run(
      normalized,
      seed ? 1 : 0,
      seed ? 0.1 : 0,
      at,
      at,
      at,
    );
    if (Number(result.changes) > 0) {
      insertLifecycle.run(normalized, null, 'DISCOVERED', reason, null, at);
      return { address: normalized, created: true };
    }
    return { address: normalized, created: false };
  };

  const applyCandidateTrade = (address, action, aggressive, trade) => {
    ensureWallet(address, { at: trade.timestamp });
    const current = selectWallet.get(address);
    const interval = current.last_trade_at === null
      ? null
      : trade.timestamp - current.last_trade_at;
    let intervalCount = current.interval_count;
    let intervalMeanMs = current.interval_mean_ms;
    let intervalM2 = current.interval_m2;
    if (interval !== null && interval > 0) {
      intervalCount += 1;
      const delta = interval - intervalMeanMs;
      intervalMeanMs += delta / intervalCount;
      intervalM2 += delta * (interval - intervalMeanMs);
    }
    const sideSwitchCount = current.last_action && current.last_action !== action
      ? current.side_switch_count + 1
      : current.side_switch_count;

    updateWallet.run(
      Math.min(current.first_seen_at, trade.timestamp),
      Math.max(current.last_seen_at, trade.timestamp),
      Math.max(current.last_trade_at ?? 0, trade.timestamp),
      current.trade_count + 1,
      current.buy_count + (action === 'buy' ? 1 : 0),
      current.sell_count + (action === 'sell' ? 1 : 0),
      current.aggressive_count + (aggressive ? 1 : 0),
      current.notional + trade.notional,
      Math.max(current.max_notional, trade.notional),
      action,
      sideSwitchCount,
      intervalCount,
      intervalMeanMs,
      intervalM2,
      Math.max(now(), trade.timestamp),
      address,
    );
  };

  const deleteOlderThan = (table, column, cutoff) =>
    Number(database.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff).changes);

  const enforceCap = (table, orderColumn, cap) => Number(database.prepare(`
    DELETE FROM ${table}
    WHERE id IN (
      SELECT id FROM ${table}
      ORDER BY ${orderColumn} DESC, id DESC
      LIMIT -1 OFFSET ?
    )
  `).run(cap).changes);

  return {
    recordTrades(trades) {
      if (!Array.isArray(trades) || trades.length > 5_000) {
        throw new Error('Trades must be an array with at most 5000 items.');
      }
      const ordered = [...trades].sort((left, right) => left.timestamp - right.timestamp);
      return withTransaction(database, () => {
        let insertedTrades = 0;
        const touchedWallets = new Set();
        for (const trade of ordered) {
          if (
            trade?.coin !== 'xyz:GOLD' ||
            !['A', 'B'].includes(trade.side) ||
            !isPositive(trade.price) ||
            !isPositive(trade.size) ||
            !isPositive(trade.notional) ||
            !Number.isSafeInteger(trade.timestamp) ||
            trade.timestamp <= 0 ||
            !Number.isSafeInteger(trade.tid) ||
            trade.tid < 0 ||
            !HASH_PATTERN.test(trade.hash ?? '') ||
            !validateAddress(trade.buyer) ||
            !validateAddress(trade.seller)
          ) {
            throw new Error('Invalid normalized gold trade.');
          }
          const buyer = trade.buyer.toLowerCase();
          const seller = trade.seller.toLowerCase();
          const result = insertTrade.run(
            trade.timestamp,
            trade.tid,
            trade.hash.toLowerCase(),
            trade.side,
            trade.price,
            trade.size,
            trade.notional,
            buyer,
            seller,
          );
          if (Number(result.changes) === 0) continue;
          insertedTrades += 1;
          touchedWallets.add(buyer);
          touchedWallets.add(seller);
          applyCandidateTrade(buyer, 'buy', trade.side === 'B', trade);
          applyCandidateTrade(seller, 'sell', trade.side === 'A', trade);
        }
        return { insertedTrades, touchedWallets: touchedWallets.size };
      });
    },

    importSeeds(addresses) {
      if (!Array.isArray(addresses) || addresses.length > MAX_SEED_ADDRESSES) {
        throw new Error('Seed addresses must be a bounded array.');
      }
      return withTransaction(database, () => {
        let imported = 0;
        for (const rawAddress of [...new Set(addresses.map(normalizeAddress))]) {
          const at = now();
          const { created } = ensureWallet(rawAddress, { at, seed: true });
          if (created) {
            imported += 1;
            continue;
          }
          const result = markSeed.run(at, rawAddress);
          if (Number(result.changes) > 0) imported += 1;
        }
        return imported;
      });
    },

    getWallet(address) {
      return mapWallet(selectWallet.get(normalizeAddress(address)));
    },

    listCandidates({ statuses = WALLET_STATUSES, reviewBefore = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
      if (
        !Array.isArray(statuses) ||
        statuses.length < 1 ||
        statuses.some((status) => !STATUS_SET.has(status)) ||
        !Number.isSafeInteger(reviewBefore) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1_000
      ) {
        throw new Error('Invalid candidate query.');
      }
      const placeholders = statuses.map(() => '?').join(', ');
      return database.prepare(`
        SELECT * FROM wallets
        WHERE status IN (${placeholders})
          AND COALESCE(next_review_at, 0) <= ?
        ORDER BY
          CASE WHEN seed = 1 THEN 0 ELSE 1 END,
          max_notional DESC,
          last_seen_at DESC
        LIMIT ?
      `).all(...statuses, reviewBefore, limit).map(mapWallet);
    },

    transitionWallet(address, toStatus, {
      reason,
      score = null,
      at = now(),
      exclusionReason = null,
    } = {}) {
      const normalized = normalizeAddress(address);
      if (!STATUS_SET.has(toStatus)) throw new Error('Unknown wallet status.');
      if (
        typeof reason !== 'string' ||
        reason.trim().length < 1 ||
        reason.length > 240
      ) {
        throw new Error('Lifecycle reason is required and must be at most 240 characters.');
      }
      if (score !== null && !isFiniteNumber(score)) throw new Error('Lifecycle score is invalid.');
      if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Lifecycle timestamp is invalid.');

      return withTransaction(database, () => {
        const current = selectWallet.get(normalized);
        if (!current) throw new Error('Wallet does not exist.');
        if (!TRANSITIONS[current.status]?.has(toStatus)) {
          throw new Error(`Invalid wallet lifecycle transition ${current.status} -> ${toStatus}.`);
        }
        transitionWalletStatement.run(
          toStatus,
          toStatus === 'EXCLUDED'
            ? String(exclusionReason ?? reason).slice(0, 240)
            : null,
          at,
          normalized,
        );
        insertLifecycle.run(
          normalized,
          current.status,
          toStatus,
          reason.trim(),
          score,
          at,
        );
        return mapWallet(selectWallet.get(normalized));
      });
    },

    listLifecycle(address) {
      const normalized = normalizeAddress(address);
      return database.prepare(`
        SELECT from_status, to_status, reason, score, at
        FROM wallet_lifecycle
        WHERE address = ?
        ORDER BY at ASC, id ASC
      `).all(normalized).map((row) => ({
        fromStatus: row.from_status,
        toStatus: row.to_status,
        reason: row.reason,
        score: row.score,
        at: row.at,
      }));
    },

    recordMarketSample(sample) {
      const features = sample?.features ?? {};
      if (
        !Number.isSafeInteger(sample?.timestamp) ||
        sample.timestamp <= 0 ||
        !isPositive(sample.hyperliquidMid) ||
        !isPositive(sample.bybitMid) ||
        !isFiniteNumber(sample.basisBps)
      ) {
        throw new Error('Invalid market sample.');
      }
      const optionalNumber = (value) => (
        value === null || value === undefined ? null : Number(value)
      );
      insertMarketSample.run(
        sample.timestamp,
        Number(sample.hyperliquidMid),
        Number(sample.bybitMid),
        Number(sample.basisBps),
        Number(features.aggressiveFlow5m ?? 0),
        Number(features.aggressiveFlow15m ?? 0),
        Number(features.aggressiveFlow60m ?? 0),
        Number(features.bookImbalance ?? 0),
        Number(features.momentum5mBps ?? 0),
        Number(features.momentum15mBps ?? 0),
        Number(features.volatilityBps ?? 0),
        Number(features.openInterestChangePct ?? 0),
        optionalNumber(sample.markPrice),
        optionalNumber(sample.oraclePrice),
        optionalNumber(sample.openInterest),
        optionalNumber(sample.funding),
        optionalNumber(sample.premium),
        typeof sample.session === 'string' ? sample.session.slice(0, 32) : null,
      );
    },

    runRetention({ at = now() } = {}) {
      if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Retention timestamp is invalid.');
      return withTransaction(database, () => {
        const deleted = {
          trades:
            deleteOlderThan('gold_trades', 'timestamp', at - retention.tradesMs) +
            enforceCap('gold_trades', 'timestamp', retention.maxTrades),
          marketSamples:
            deleteOlderThan('market_samples', 'timestamp', at - retention.marketSamplesMs) +
            enforceCap('market_samples', 'timestamp', retention.maxMarketSamples),
          fills:
            deleteOlderThan('wallet_fills', 'timestamp', at - retention.fillsMs) +
            enforceCap('wallet_fills', 'timestamp', retention.maxFills),
          episodes:
            deleteOlderThan('episodes', 'opened_at', at - retention.episodesMs) +
            enforceCap('episodes', 'opened_at', retention.maxEpisodes),
          predictions:
            deleteOlderThan('predictions', 'created_at', at - retention.predictionsMs) +
            enforceCap('predictions', 'created_at', retention.maxPredictions),
          lifecycleEvents:
            deleteOlderThan('wallet_lifecycle', 'at', at - retention.lifecycleMs) +
            enforceCap('wallet_lifecycle', 'at', retention.maxLifecycleEvents),
        };
        database.prepare(`
          INSERT INTO service_meta(key, value) VALUES ('last_retention_at', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(String(at));
        if (!inMemory) {
          database.exec('PRAGMA wal_checkpoint(PASSIVE)');
          database.exec('PRAGMA incremental_vacuum(200)');
        }
        return { at, deleted };
      });
    },

    inspectSchema() {
      return database.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE sql IS NOT NULL
        ORDER BY type, name
      `).all().map(({ sql }) => sql).join('\n');
    },

    getHealth() {
      const schemaVersion = Number(database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get().version ?? 0);
      const journalRow = database.prepare('PRAGMA journal_mode').get();
      const pageCount = Number(database.prepare('PRAGMA page_count').get().page_count);
      const pageSize = Number(database.prepare('PRAGMA page_size').get().page_size);
      const freelistPages = Number(database.prepare('PRAGMA freelist_count').get().freelist_count);
      const lastRetention = database.prepare(
        "SELECT value FROM service_meta WHERE key = 'last_retention_at'",
      ).get();
      const count = (table) => Number(database.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).get().count);
      let walBytes = 0;
      if (!inMemory) {
        try {
          walBytes = statSync(`${path}-wal`).size;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }

      return {
        schemaVersion,
        journalMode: journalRow.journal_mode,
        databaseBytes: pageCount * pageSize,
        walBytes,
        pageCount,
        freelistPages,
        lastRetentionAt: lastRetention ? Number(lastRetention.value) : null,
        rows: {
          wallets: count('wallets'),
          lifecycleEvents: count('wallet_lifecycle'),
          trades: count('gold_trades'),
          marketSamples: count('market_samples'),
          fills: count('wallet_fills'),
          episodes: count('episodes'),
          cohortMemberships: count('cohort_memberships'),
          predictions: count('predictions'),
        },
      };
    },

    close() {
      if (closed) return;
      if (!inMemory) database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      database.close();
      closed = true;
    },
  };
}

