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
  RETIRED: new Set(['OBSERVED', 'EXCLUDED']),
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
    position_side TEXT CHECK(position_side IN ('LONG', 'SHORT')),
    position_size REAL,
    position_entry_price REAL,
    position_value REAL,
    position_unrealized_pnl REAL,
    position_updated_at INTEGER,
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
    history_truncated INTEGER NOT NULL DEFAULT 0 CHECK(history_truncated IN (0, 1)),
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
    session TEXT NOT NULL,
    regime TEXT NOT NULL,
    confidence REAL NOT NULL,
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
    probability_sum REAL NOT NULL DEFAULT 0,
    outcome_sum REAL NOT NULL DEFAULT 0,
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
    positionSide: row.position_side,
    positionSize: row.position_size,
    positionEntryPrice: row.position_entry_price,
    positionValue: row.position_value,
    positionUnrealizedPnl: row.position_unrealized_pnl,
    positionUpdatedAt: row.position_updated_at,
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
  const setWalletReviewStatement = database.prepare(`
    UPDATE wallets
      SET next_review_at = ?, updated_at = ?
      WHERE address = ?
  `);
  const recordPositionStatement = database.prepare(`
    UPDATE wallets SET
      position_side = ?,
      position_size = ?,
      position_entry_price = ?,
      position_value = ?,
      position_unrealized_pnl = ?,
      position_updated_at = ?,
      updated_at = ?
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
  const insertFill = database.prepare(`
    INSERT OR IGNORE INTO wallet_fills (
      address, timestamp, tid, hash, oid, side, direction, price, size,
      start_position, closed_pnl, crossed, fee
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEpisode = database.prepare(`
    INSERT INTO episodes (
      address, side, opened_at, closed_at, entry_price, exit_price,
      peak_size, closed_pnl, hold_ms, mfe_bps, mae_bps, captured_bps,
      fill_count, aggressive_ratio, session, regime, target_band,
      complete, history_truncated, reconstructed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const saveScoreStatement = database.prepare(`
    INSERT INTO wallet_scores (
      address, calculated_at, episode_count, win_rate, wilson_lower,
      profit_factor, sharpe, ewma_quality, anti_luck, long_quality,
      short_quality, overall_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      calculated_at = excluded.calculated_at,
      episode_count = excluded.episode_count,
      win_rate = excluded.win_rate,
      wilson_lower = excluded.wilson_lower,
      profit_factor = excluded.profit_factor,
      sharpe = excluded.sharpe,
      ewma_quality = excluded.ewma_quality,
      anti_luck = excluded.anti_luck,
      long_quality = excluded.long_quality,
      short_quality = excluded.short_quality,
      overall_score = excluded.overall_score
  `);
  const insertCohortMembership = database.prepare(`
    INSERT INTO cohort_memberships (
      address, cohort, score, started_at, ended_at, reason
    ) VALUES (?, ?, ?, ?, NULL, ?)
  `);
  const updateCohortMembership = database.prepare(`
    UPDATE cohort_memberships
      SET score = ?, reason = ?
      WHERE id = ?
  `);
  const endCohortMembership = database.prepare(`
    UPDATE cohort_memberships
      SET ended_at = ?
      WHERE id = ? AND ended_at IS NULL
  `);
  const insertPrediction = database.prepare(`
    INSERT OR IGNORE INTO predictions (
      fingerprint, created_at, expires_at, entry_price, up_barrier,
      down_barrier, fp_direction, stage, session, regime, confidence,
      probability_up, probability_down, probability_neither,
      market_probability, wallet_probability, combined_probability,
      maturity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const resolvePrediction = database.prepare(`
    UPDATE predictions
      SET outcome = ?, outcome_at = ?
      WHERE id = ? AND outcome IS NULL
  `);
  const updateModelMetric = database.prepare(`
    INSERT INTO model_metrics (
      bucket, resolved_count, brier_sum, hit_count,
      probability_sum, outcome_sum, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      resolved_count = resolved_count + 1,
      brier_sum = brier_sum + excluded.brier_sum,
      hit_count = hit_count + excluded.hit_count,
      probability_sum = probability_sum + excluded.probability_sum,
      outcome_sum = outcome_sum + excluded.outcome_sum,
      updated_at = excluded.updated_at
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

    setWalletReview(address, nextReviewAt, { at = now() } = {}) {
      const normalized = normalizeAddress(address);
      if (
        !Number.isSafeInteger(nextReviewAt) ||
        nextReviewAt <= 0 ||
        !Number.isSafeInteger(at) ||
        at <= 0
      ) {
        throw new Error('Wallet review timestamp is invalid.');
      }
      const result = setWalletReviewStatement.run(nextReviewAt, at, normalized);
      if (Number(result.changes) !== 1) throw new Error('Wallet does not exist.');
      return mapWallet(selectWallet.get(normalized));
    },

    recordGoldPosition(address, position, { at = now() } = {}) {
      const normalized = normalizeAddress(address);
      if (!Number.isSafeInteger(at) || at <= 0) {
        throw new Error('Position timestamp is invalid.');
      }
      if (position !== null && (
        !['LONG', 'SHORT'].includes(position?.side) ||
        !isPositive(position.size) ||
        !isPositive(position.entryPrice) ||
        !isFiniteNumber(position.positionValue) ||
        !isFiniteNumber(position.unrealizedPnl)
      )) {
        throw new Error('Gold position is invalid.');
      }
      const result = recordPositionStatement.run(
        position?.side ?? null,
        position?.size ?? null,
        position?.entryPrice ?? null,
        position?.positionValue ?? null,
        position?.unrealizedPnl ?? null,
        at,
        at,
        normalized,
      );
      if (Number(result.changes) !== 1) throw new Error('Wallet does not exist.');
      return mapWallet(selectWallet.get(normalized));
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

    recordFills(address, fills) {
      const normalized = normalizeAddress(address);
      if (!selectWallet.get(normalized)) throw new Error('Wallet does not exist.');
      if (!Array.isArray(fills) || fills.length > 10_000) {
        throw new Error('Fills must be a bounded array.');
      }
      return withTransaction(database, () => {
        let inserted = 0;
        for (const fill of fills) {
          if (
            fill?.address !== normalized ||
            fill.coin !== 'xyz:GOLD' ||
            !Number.isSafeInteger(fill.timestamp) ||
            fill.timestamp <= 0 ||
            !Number.isSafeInteger(fill.tid) ||
            fill.tid < 0 ||
            !HASH_PATTERN.test(fill.hash ?? '') ||
            !Number.isSafeInteger(fill.oid) ||
            fill.oid < 0 ||
            !['A', 'B'].includes(fill.side) ||
            typeof fill.direction !== 'string' ||
            fill.direction.length < 1 ||
            fill.direction.length > 80 ||
            !isPositive(fill.price) ||
            !isPositive(fill.size) ||
            !isFiniteNumber(fill.startPosition) ||
            !isFiniteNumber(fill.closedPnl) ||
            typeof fill.crossed !== 'boolean' ||
            !isFiniteNumber(fill.fee)
          ) {
            throw new Error('Invalid normalized gold fill.');
          }
          const result = insertFill.run(
            normalized,
            fill.timestamp,
            fill.tid,
            fill.hash,
            fill.oid,
            fill.side,
            fill.direction,
            fill.price,
            fill.size,
            fill.startPosition,
            fill.closedPnl,
            fill.crossed ? 1 : 0,
            fill.fee,
          );
          inserted += Number(result.changes);
        }
        return inserted;
      });
    },

    listFills(address, { limit = 10_000 } = {}) {
      const normalized = normalizeAddress(address);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error('Fill limit is invalid.');
      }
      return database.prepare(`
        SELECT * FROM wallet_fills
        WHERE address = ?
        ORDER BY timestamp ASC, tid ASC
        LIMIT ?
      `).all(normalized, limit).map((row) => ({
        address: row.address,
        coin: 'xyz:GOLD',
        timestamp: row.timestamp,
        tid: row.tid,
        hash: row.hash,
        oid: row.oid,
        side: row.side,
        direction: row.direction,
        price: row.price,
        size: row.size,
        startPosition: row.start_position,
        closedPnl: row.closed_pnl,
        crossed: toBoolean(row.crossed),
        fee: row.fee,
      }));
    },

    replaceEpisodes(address, episodes) {
      const normalized = normalizeAddress(address);
      if (!selectWallet.get(normalized)) throw new Error('Wallet does not exist.');
      if (!Array.isArray(episodes) || episodes.length > 5_000) {
        throw new Error('Episodes must be a bounded array.');
      }
      return withTransaction(database, () => {
        database.prepare('DELETE FROM episodes WHERE address = ?').run(normalized);
        let inserted = 0;
        for (const episode of episodes) {
          if (
            episode?.address !== normalized ||
            !['LONG', 'SHORT'].includes(episode.side) ||
            !Number.isSafeInteger(episode.openedAt) ||
            episode.openedAt <= 0 ||
            (episode.closedAt !== null && !Number.isSafeInteger(episode.closedAt)) ||
            !isPositive(episode.entryPrice) ||
            (episode.exitPrice !== null && !isPositive(episode.exitPrice)) ||
            !isPositive(episode.peakSize) ||
            !isFiniteNumber(episode.closedPnl) ||
            !Number.isInteger(episode.fillCount) ||
            episode.fillCount < 1 ||
            !isFiniteNumber(episode.aggressiveRatio)
          ) {
            throw new Error('Invalid reconstructed episode.');
          }
          const result = insertEpisode.run(
            normalized,
            episode.side,
            episode.openedAt,
            episode.closedAt,
            episode.entryPrice,
            episode.exitPrice,
            episode.peakSize,
            episode.closedPnl,
            episode.holdMs,
            episode.mfeBps,
            episode.maeBps,
            episode.capturedBps,
            episode.fillCount,
            episode.aggressiveRatio,
            episode.session ?? null,
            episode.regime ?? 'UNKNOWN',
            episode.targetBand ?? null,
            episode.complete ? 1 : 0,
            episode.historyTruncated ? 1 : 0,
            now(),
          );
          inserted += Number(result.changes);
        }
        return inserted;
      });
    },

    listEpisodes(address, { completeOnly = false, limit = 5_000 } = {}) {
      const normalized = normalizeAddress(address);
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
        throw new Error('Episode limit is invalid.');
      }
      return database.prepare(`
        SELECT * FROM episodes
        WHERE address = ?
          AND (? = 0 OR complete = 1)
        ORDER BY opened_at ASC, id ASC
        LIMIT ?
      `).all(normalized, completeOnly ? 1 : 0, limit).map((row) => ({
        address: row.address,
        side: row.side,
        openedAt: row.opened_at,
        closedAt: row.closed_at,
        entryPrice: row.entry_price,
        exitPrice: row.exit_price,
        peakSize: row.peak_size,
        closedPnl: row.closed_pnl,
        holdMs: row.hold_ms,
        mfeBps: row.mfe_bps,
        maeBps: row.mae_bps,
        capturedBps: row.captured_bps,
        fillCount: row.fill_count,
        aggressiveRatio: row.aggressive_ratio,
        session: row.session,
        regime: row.regime,
        targetBand: row.target_band,
        complete: toBoolean(row.complete),
        historyTruncated: toBoolean(row.history_truncated),
      }));
    },

    saveWalletScore(address, score) {
      const normalized = normalizeAddress(address);
      if (!selectWallet.get(normalized)) throw new Error('Wallet does not exist.');
      const required = [
        'calculatedAt',
        'episodeCount',
        'winRate',
        'wilsonLower',
        'profitFactor',
        'sharpe',
        'ewmaQuality',
        'antiLuck',
        'longQuality',
        'shortQuality',
        'overallScore',
      ];
      if (
        !score ||
        required.some((key) => !isFiniteNumber(score[key])) ||
        !Number.isSafeInteger(score.calculatedAt) ||
        !Number.isInteger(score.episodeCount) ||
        score.episodeCount < 0
      ) {
        throw new Error('Wallet score is invalid.');
      }
      saveScoreStatement.run(
        normalized,
        score.calculatedAt,
        score.episodeCount,
        score.winRate,
        score.wilsonLower,
        score.profitFactor,
        score.sharpe,
        score.ewmaQuality,
        score.antiLuck,
        score.longQuality,
        score.shortQuality,
        score.overallScore,
      );
    },

    getWalletScore(address) {
      const normalized = normalizeAddress(address);
      const row = database.prepare(
        'SELECT * FROM wallet_scores WHERE address = ?',
      ).get(normalized);
      if (!row) return null;
      return {
        address: row.address,
        calculatedAt: row.calculated_at,
        episodeCount: row.episode_count,
        winRate: row.win_rate,
        wilsonLower: row.wilson_lower,
        profitFactor: row.profit_factor,
        sharpe: row.sharpe,
        ewmaQuality: row.ewma_quality,
        antiLuck: row.anti_luck,
        longQuality: row.long_quality,
        shortQuality: row.short_quality,
        overallScore: row.overall_score,
      };
    },

    replaceCohortMemberships(address, memberships, { at = now() } = {}) {
      const normalized = normalizeAddress(address);
      if (!selectWallet.get(normalized)) throw new Error('Wallet does not exist.');
      if (
        !Array.isArray(memberships) ||
        memberships.length > 100 ||
        !Number.isSafeInteger(at) ||
        at <= 0
      ) {
        throw new Error('Cohort membership update is invalid.');
      }
      const desired = new Map();
      for (const membership of memberships) {
        if (
          !/^[A-Z0-9_]{2,64}$/.test(membership?.cohort ?? '') ||
          !isFiniteNumber(membership.score) ||
          membership.score < 0 ||
          membership.score > 1 ||
          typeof membership.reason !== 'string' ||
          membership.reason.length < 1 ||
          membership.reason.length > 240
        ) {
          throw new Error('Cohort membership is invalid.');
        }
        desired.set(membership.cohort, membership);
      }

      return withTransaction(database, () => {
        const currentRows = database.prepare(`
          SELECT * FROM cohort_memberships
          WHERE address = ? AND ended_at IS NULL
        `).all(normalized);
        const current = new Map(currentRows.map((row) => [row.cohort, row]));
        let changed = 0;
        for (const [cohort, row] of current) {
          if (desired.has(cohort)) continue;
          changed += Number(endCohortMembership.run(at, row.id).changes);
        }
        for (const [cohort, membership] of desired) {
          const existing = current.get(cohort);
          if (existing) {
            changed += Number(updateCohortMembership.run(
              membership.score,
              membership.reason,
              existing.id,
            ).changes);
          } else {
            changed += Number(insertCohortMembership.run(
              normalized,
              cohort,
              membership.score,
              at,
              membership.reason,
            ).changes);
          }
        }
        return changed;
      });
    },

    listCohortMemberships(address, { activeOnly = true } = {}) {
      const normalized = normalizeAddress(address);
      return database.prepare(`
        SELECT cohort, score, started_at, ended_at, reason
        FROM cohort_memberships
        WHERE address = ?
          AND (? = 0 OR ended_at IS NULL)
        ORDER BY cohort ASC, started_at ASC
      `).all(normalized, activeOnly ? 1 : 0).map((row) => ({
        cohort: row.cohort,
        score: row.score,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        reason: row.reason,
      }));
    },

    listActiveWalletSignals({ limit = 1_000 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
        throw new Error('Active wallet signal limit is invalid.');
      }
      const rows = database.prepare(`
        SELECT
          w.address,
          w.status,
          w.position_side,
          w.position_size,
          w.position_entry_price,
          w.position_value,
          w.position_unrealized_pnl,
          w.position_updated_at,
          s.episode_count,
          s.overall_score,
          s.long_quality,
          s.short_quality
        FROM wallets w
        JOIN wallet_scores s ON s.address = w.address
        WHERE w.status = 'ACTIVE_COHORT'
          AND w.position_side IS NOT NULL
          AND w.position_updated_at IS NOT NULL
        ORDER BY s.overall_score DESC, w.position_value DESC
        LIMIT ?
      `).all(limit);
      const membershipQuery = database.prepare(`
        SELECT cohort, score
        FROM cohort_memberships
        WHERE address = ? AND ended_at IS NULL
        ORDER BY cohort ASC
      `);
      return rows.map((row) => ({
        address: row.address,
        status: row.status,
        positionSide: row.position_side,
        positionSize: row.position_size,
        positionEntryPrice: row.position_entry_price,
        positionValue: row.position_value,
        positionUnrealizedPnl: row.position_unrealized_pnl,
        positionUpdatedAt: row.position_updated_at,
        score: {
          episodeCount: row.episode_count,
          overallScore: row.overall_score,
          longQuality: row.long_quality,
          shortQuality: row.short_quality,
        },
        memberships: membershipQuery.all(row.address).map((membership) => ({
          cohort: membership.cohort,
          score: membership.score,
        })),
      }));
    },

    recordPrediction(prediction) {
      const probabilities = [
        prediction?.probabilityUp,
        prediction?.probabilityDown,
        prediction?.probabilityNeither,
      ];
      const probabilitySum = probabilities.reduce((sum, value) => sum + Number(value), 0);
      if (
        !/^[0-9a-f]{64}$/.test(prediction?.fingerprint ?? '') ||
        !Number.isSafeInteger(prediction.createdAt) ||
        !Number.isSafeInteger(prediction.expiresAt) ||
        prediction.expiresAt <= prediction.createdAt ||
        !isPositive(prediction.entryPrice) ||
        !isPositive(prediction.upBarrier) ||
        !isPositive(prediction.downBarrier) ||
        prediction.downBarrier >= prediction.entryPrice ||
        prediction.upBarrier <= prediction.entryPrice ||
        !['long', 'short'].includes(prediction.fpDirection) ||
        typeof prediction.stage !== 'string' ||
        typeof prediction.session !== 'string' ||
        typeof prediction.regime !== 'string' ||
        !isFiniteNumber(prediction.confidence) ||
        probabilities.some((value) => !isFiniteNumber(value) || value < 0 || value > 1) ||
        Math.abs(probabilitySum - 1) > 1e-6 ||
        !isFiniteNumber(prediction.marketProbability) ||
        (
          prediction.walletProbability !== null &&
          !isFiniteNumber(prediction.walletProbability)
        ) ||
        !isFiniteNumber(prediction.combinedProbability) ||
        !isFiniteNumber(prediction.maturity)
      ) {
        throw new Error('Prediction is invalid.');
      }
      const result = insertPrediction.run(
        prediction.fingerprint,
        prediction.createdAt,
        prediction.expiresAt,
        prediction.entryPrice,
        prediction.upBarrier,
        prediction.downBarrier,
        prediction.fpDirection,
        prediction.stage.slice(0, 32),
        prediction.session.slice(0, 32),
        prediction.regime.slice(0, 32),
        prediction.confidence,
        prediction.probabilityUp,
        prediction.probabilityDown,
        prediction.probabilityNeither,
        prediction.marketProbability,
        prediction.walletProbability,
        prediction.combinedProbability,
        prediction.maturity,
      );
      return Number(result.changes);
    },

    resolvePredictionsWithPrice({ timestamp, bybitMid }) {
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp <= 0 ||
        !isPositive(bybitMid)
      ) {
        throw new Error('Outcome price sample is invalid.');
      }
      return withTransaction(database, () => {
        const rows = database.prepare(`
          SELECT * FROM predictions
          WHERE outcome IS NULL AND created_at < ?
          ORDER BY created_at ASC
          LIMIT 5000
        `).all(timestamp);
        const result = { resolved: 0, down: 0, up: 0, neither: 0 };

        for (const row of rows) {
          let outcome = null;
          if (timestamp <= row.expires_at && bybitMid <= row.down_barrier) outcome = 'DOWN';
          else if (timestamp <= row.expires_at && bybitMid >= row.up_barrier) outcome = 'UP';
          else if (timestamp >= row.expires_at) outcome = 'NEITHER';
          if (!outcome) continue;
          if (Number(resolvePrediction.run(outcome, timestamp, row.id).changes) !== 1) continue;

          const outcomeKey = outcome.toLowerCase();
          result.resolved += 1;
          result[outcomeKey] += 1;
          const observed = {
            UP: [1, 0, 0],
            DOWN: [0, 1, 0],
            NEITHER: [0, 0, 1],
          }[outcome];
          const predicted = [
            row.probability_up,
            row.probability_down,
            row.probability_neither,
          ];
          const brier = predicted.reduce(
            (sum, probability, index) => sum + ((probability - observed[index]) ** 2),
            0,
          ) / 3;
          const predictedIndex = predicted.indexOf(Math.max(...predicted));
          const observedIndex = observed.indexOf(1);
          const predictedMaximum = predicted[predictedIndex];
          const correct = predictedIndex === observedIndex ? 1 : 0;
          const lower = Math.floor(predictedMaximum * 10) * 10;
          const upper = Math.min(100, lower + 10);
          const bucket = `CAL_${String(lower).padStart(2, '0')}_${String(upper).padStart(2, '0')}`;
          updateModelMetric.run('ALL', brier, correct, predictedMaximum, correct, timestamp);
          updateModelMetric.run(bucket, brier, correct, predictedMaximum, correct, timestamp);
        }
        return result;
      });
    },

    listPredictions({ resolvedOnly = false, limit = 1_000 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        throw new Error('Prediction limit is invalid.');
      }
      return database.prepare(`
        SELECT * FROM predictions
        WHERE (? = 0 OR outcome IS NOT NULL)
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `).all(resolvedOnly ? 1 : 0, limit).map((row) => ({
        fingerprint: row.fingerprint,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        entryPrice: row.entry_price,
        upBarrier: row.up_barrier,
        downBarrier: row.down_barrier,
        fpDirection: row.fp_direction,
        stage: row.stage,
        session: row.session,
        regime: row.regime,
        confidence: row.confidence,
        probabilityUp: row.probability_up,
        probabilityDown: row.probability_down,
        probabilityNeither: row.probability_neither,
        marketProbability: row.market_probability,
        walletProbability: row.wallet_probability,
        combinedProbability: row.combined_probability,
        maturity: row.maturity,
        outcome: row.outcome,
        outcomeAt: row.outcome_at,
      }));
    },

    getModelMetrics() {
      const all = database.prepare(
        "SELECT * FROM model_metrics WHERE bucket = 'ALL'",
      ).get();
      const calibration = database.prepare(`
        SELECT * FROM model_metrics
        WHERE bucket LIKE 'CAL_%'
        ORDER BY bucket ASC
      `).all().map((row) => ({
        bucket: row.bucket,
        count: row.resolved_count,
        predictedRate: row.resolved_count > 0
          ? row.probability_sum / row.resolved_count
          : 0,
        observedRate: row.resolved_count > 0
          ? row.outcome_sum / row.resolved_count
          : 0,
      }));
      if (!all) {
        return {
          resolvedCount: 0,
          brierScore: null,
          hitRate: null,
          calibration,
        };
      }
      return {
        resolvedCount: all.resolved_count,
        brierScore: all.brier_sum / all.resolved_count,
        hitRate: all.hit_count / all.resolved_count,
        calibration,
      };
    },

    listMarketSamples({ from, to, limit = 50_000 } = {}) {
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        to < from ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50_000
      ) {
        throw new Error('Market sample range is invalid.');
      }
      return database.prepare(`
        SELECT timestamp, bybit_mid, momentum_15m_bps
        FROM market_samples
        WHERE timestamp BETWEEN ? AND ?
        ORDER BY timestamp ASC
        LIMIT ?
      `).all(from, to, limit).map((row) => ({
        timestamp: row.timestamp,
        price: row.bybit_mid,
        regime: Math.abs(row.momentum_15m_bps) >= 20 ? 'TREND' : 'RANGE',
      }));
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
