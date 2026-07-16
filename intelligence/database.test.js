import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  WALLET_STATUSES,
  createIntelligenceDatabase,
  loadSeedAddresses,
} from './database.js';

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';
const SEED = '0x3333333333333333333333333333333333333333';

const goldTrade = (overrides = {}) => ({
  coin: 'xyz:GOLD',
  side: 'B',
  price: 4035.5,
  size: 0.25,
  notional: 1008.875,
  timestamp: 1784194000000,
  hash: `0x${'a'.repeat(64)}`,
  tid: 123456789,
  buyer: BUYER,
  seller: SELLER,
  aggressor: 'buyer',
  ...overrides,
});

test('database creates a strict independent schema with bounded storage tables', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'calcpro-intelligence-'));
  const path = join(directory, 'hypergold.sqlite');
  const database = createIntelligenceDatabase({ path });
  t.after(() => database.close());

  assert.equal(statSync(path).mode & 0o077, 0);
  const health = database.getHealth();
  assert.equal(health.schemaVersion, 2);
  assert.equal(health.journalMode, 'wal');
  assert.ok(health.databaseBytes > 0);
  assert.deepEqual(Object.keys(health.rows).sort(), [
    'cohortMemberships',
    'decisionHistory',
    'episodes',
    'fills',
    'lifecycleEvents',
    'marketSamples',
    'predictions',
    'sentimentSnapshots',
    'trades',
    'walletPositionSamples',
    'wallets',
  ]);

  const schema = database.inspectSchema();
  assert.match(schema, /CREATE TABLE gold_trades/);
  assert.match(schema, /CREATE TABLE wallet_position_samples/);
  assert.match(schema, /CREATE TABLE sentiment_snapshots/);
  assert.match(schema, /CREATE TABLE decision_history/);
  assert.match(schema, /STRICT/);
  assert.doesNotMatch(schema, /raw_json|payload_json/i);
});

test('position reconciliation stores additive samples and aggregate sentiment history', (t) => {
  const clock = 1784194000000;
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => clock });
  t.after(() => database.close());
  database.importSeeds([SEED]);

  database.recordGoldPosition(SEED, {
    side: 'SHORT',
    size: 2.5,
    entryPrice: 4032,
    positionValue: 10_080,
    unrealizedPnl: 50,
  }, { at: clock });
  database.recordGoldPosition(SEED, null, { at: clock + 15 * 60 * 1_000 });

  assert.deepEqual(database.listWalletPositionSamples({
    from: clock,
    to: clock + 15 * 60 * 1_000,
  }).map((sample) => ({
    side: sample.side,
    size: sample.size,
    positionValue: sample.positionValue,
  })), [
    { side: 'SHORT', size: 2.5, positionValue: 10_080 },
    { side: 'FLAT', size: 0, positionValue: 0 },
  ]);

  assert.equal(database.recordSentimentSnapshot({
    timestamp: clock,
    marketScore: -61,
    whaleScore: -72,
    combinedScore: -66,
    direction: 'SHORT',
    qualifiedCount: 7,
    freshnessMs: 42_000,
    maturity: 0.72,
  }), 1);
  assert.equal(database.getHealth().rows.walletPositionSamples, 2);
  assert.equal(database.getHealth().rows.sentimentSnapshots, 1);
});

test('trade ingestion is idempotent and updates cheap candidate statistics', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:' });
  t.after(() => database.close());

  assert.deepEqual(database.recordTrades([goldTrade(), goldTrade()]), {
    insertedTrades: 1,
    touchedWallets: 2,
  });
  database.recordTrades([goldTrade({
    side: 'A',
    aggressor: 'seller',
    tid: 123456790,
    timestamp: 1784194001000,
    size: 0.5,
    notional: 2017.75,
  })]);

  const buyer = database.getWallet(BUYER);
  const seller = database.getWallet(SELLER);
  assert.equal(buyer.status, 'DISCOVERED');
  assert.equal(buyer.tradeCount, 2);
  assert.equal(buyer.buyCount, 2);
  assert.equal(buyer.sellCount, 0);
  assert.equal(buyer.aggressiveCount, 1);
  assert.equal(buyer.intervalCount, 1);
  assert.equal(buyer.intervalMeanMs, 1000);
  assert.equal(seller.sellCount, 2);
  assert.equal(seller.aggressiveCount, 1);
  assert.equal(database.getHealth().rows.trades, 2);
  assert.equal(database.getHealth().rows.lifecycleEvents, 2);
});

test('server-only seed import is validated, idempotent, and low confidence', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'calcpro-seeds-'));
  const seedPath = join(directory, 'seed-wallets.json');
  writeFileSync(seedPath, JSON.stringify({
    addresses: [SEED, SEED.toUpperCase(), 'broken'],
  }), { mode: 0o600 });

  assert.deepEqual(loadSeedAddresses(seedPath), [SEED]);

  const database = createIntelligenceDatabase({ path: ':memory:', now: () => 5000 });
  t.after(() => database.close());
  assert.equal(database.importSeeds(loadSeedAddresses(seedPath)), 1);
  assert.equal(database.importSeeds(loadSeedAddresses(seedPath)), 0);

  const wallet = database.getWallet(SEED);
  assert.equal(wallet.seed, true);
  assert.equal(wallet.trust, 0.1);
  assert.equal(wallet.status, 'DISCOVERED');
  assert.equal(wallet.firstSeenAt, 5000);
});

test('wallet lifecycle accepts only declared transitions and preserves reasons', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => 1000 });
  t.after(() => database.close());
  database.importSeeds([SEED]);

  database.transitionWallet(SEED, 'OBSERVED', {
    reason: 'candidate threshold reached',
    score: 0.42,
    at: 2000,
  });
  database.transitionWallet(SEED, 'QUALIFIED', {
    reason: 'episode quality passed',
    score: 0.68,
    at: 3000,
  });
  assert.throws(
    () => database.transitionWallet(SEED, 'DISCOVERED', { reason: 'invalid rollback' }),
    /Invalid wallet lifecycle transition/,
  );
  assert.throws(
    () => database.transitionWallet(SEED, 'UNKNOWN', { reason: 'invalid status' }),
    /Unknown wallet status/,
  );

  assert.deepEqual(WALLET_STATUSES, [
    'DISCOVERED',
    'OBSERVED',
    'QUALIFIED',
    'ACTIVE_COHORT',
    'PROBATION',
    'RETIRED',
    'EXCLUDED',
  ]);
  assert.deepEqual(database.listLifecycle(SEED).map((event) => ({
    from: event.fromStatus,
    to: event.toStatus,
    reason: event.reason,
  })), [
    { from: null, to: 'DISCOVERED', reason: 'seed import' },
    { from: 'DISCOVERED', to: 'OBSERVED', reason: 'candidate threshold reached' },
    { from: 'OBSERVED', to: 'QUALIFIED', reason: 'episode quality passed' },
  ]);
});

test('retention removes expired high-volume rows and enforces row caps', (t) => {
  const day = 24 * 60 * 60 * 1000;
  const now = 200 * day;
  const database = createIntelligenceDatabase({
    path: ':memory:',
    now: () => now,
    retention: {
      tradesMs: 7 * day,
      marketSamplesMs: 30 * day,
      fillsMs: 90 * day,
      episodesMs: 365 * day,
      predictionsMs: 180 * day,
      lifecycleMs: 365 * day,
      maxTrades: 2,
      maxMarketSamples: 2,
      maxFills: 2,
      maxEpisodes: 2,
      maxPredictions: 2,
      maxLifecycleEvents: 10,
    },
  });
  t.after(() => database.close());

  database.recordTrades([
    goldTrade({ timestamp: now - (8 * day), tid: 1 }),
    goldTrade({ timestamp: now - 3000, tid: 2 }),
    goldTrade({ timestamp: now - 2000, tid: 3 }),
    goldTrade({ timestamp: now - 1000, tid: 4 }),
  ]);
  database.recordMarketSample({
    timestamp: now - (31 * day),
    hyperliquidMid: 4000,
    bybitMid: 4000,
    basisBps: 0,
    features: {},
  });
  database.recordMarketSample({
    timestamp: now - 2000,
    hyperliquidMid: 4010,
    bybitMid: 4010,
    basisBps: 0,
    features: {},
  });
  database.recordMarketSample({
    timestamp: now - 1000,
    hyperliquidMid: 4020,
    bybitMid: 4020,
    basisBps: 0,
    features: {},
  });
  database.recordMarketSample({
    timestamp: now,
    hyperliquidMid: 4030,
    bybitMid: 4030,
    basisBps: 0,
    features: {},
  });

  const result = database.runRetention({ at: now });
  assert.ok(result.deleted.trades >= 2);
  assert.ok(result.deleted.marketSamples >= 2);
  assert.equal(database.getHealth().rows.trades, 2);
  assert.equal(database.getHealth().rows.marketSamples, 2);
  assert.equal(database.getHealth().lastRetentionAt, now);
});

test('retention checkpoints a production WAL database outside its write transaction', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'calcpro-retention-wal-'));
  const path = join(directory, 'hypergold.sqlite');
  const now = 1784194000000;
  const database = createIntelligenceDatabase({ path, now: () => now });
  t.after(() => database.close());

  assert.doesNotThrow(() => database.runRetention({ at: now }));
  assert.equal(database.getHealth().lastRetentionAt, now);
});

test('seed loader rejects oversized or malformed files without leaking contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'calcpro-seed-errors-'));
  const malformed = join(directory, 'malformed.json');
  const oversized = join(directory, 'oversized.json');
  writeFileSync(malformed, '{secret-not-json', { mode: 0o600 });
  writeFileSync(oversized, `"${'x'.repeat(300_000)}"`, { mode: 0o600 });

  assert.throws(() => loadSeedAddresses(malformed), /Seed file is not valid JSON/);
  assert.throws(() => loadSeedAddresses(oversized), /Seed file exceeds/);
  assert.ok(readFileSync(malformed, 'utf8').includes('secret-not-json'));
});
