import assert from 'node:assert/strict';
import test from 'node:test';

import { createCandidateObserver, screenCandidate } from './candidate-observer.js';
import { createIntelligenceDatabase } from './database.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

const normalizedFill = ({
  timestamp,
  side,
  startPosition,
  size,
  price,
  tid,
  closedPnl = 0,
}) => ({
  address: ADDRESS,
  coin: 'xyz:GOLD',
  timestamp,
  side,
  startPosition,
  size,
  price,
  tid,
  closedPnl,
  crossed: true,
  direction: side === 'B' ? 'Open Long' : 'Close Long',
  hash: `0x${String(tid).padStart(64, 'a').slice(-64)}`,
  oid: tid + 100,
  fee: 0,
});

test('cheap screen promotes promising seeds and excludes periodic high-frequency wallets', () => {
  assert.deepEqual(screenCandidate({
    seed: true,
    tradeCount: 0,
    notional: 0,
    maxNotional: 0,
    intervalCount: 0,
    intervalMeanMs: 0,
    intervalM2: 0,
    sideSwitchCount: 0,
  }), {
    decision: 'observe',
    reason: 'server seed requires independent evaluation',
  });

  const periodic = screenCandidate({
    seed: false,
    tradeCount: 50,
    notional: 100_000,
    maxNotional: 5_000,
    intervalCount: 49,
    intervalMeanMs: 1000,
    intervalM2: 0,
    sideSwitchCount: 40,
  });
  assert.equal(periodic.decision, 'exclude');
  assert.match(periodic.reason, /periodic high-frequency/);

  assert.equal(screenCandidate({
    seed: false,
    tradeCount: 1,
    notional: 50,
    maxNotional: 50,
    intervalCount: 0,
    intervalMeanMs: 0,
    intervalM2: 0,
    sideSwitchCount: 0,
  }).decision, 'wait');
});

test('candidate observer backfills, reconstructs, classifies, and records xyz position', async (t) => {
  const hour = 60 * 60 * 1000;
  const now = 100 * hour;
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => now });
  t.after(() => database.close());
  database.importSeeds([ADDRESS]);

  const fills = [];
  for (let index = 0; index < 3; index += 1) {
    const openedAt = now - ((8 - (index * 2)) * hour);
    fills.push(
      normalizedFill({
        timestamp: openedAt,
        side: 'B',
        startPosition: 0,
        size: 1,
        price: 4000 + index,
        tid: (index * 2) + 1,
      }),
      normalizedFill({
        timestamp: openedAt + (30 * 60 * 1000),
        side: 'A',
        startPosition: 1,
        size: 1,
        price: 4020 + index,
        tid: (index * 2) + 2,
        closedPnl: 20,
      }),
    );
  }

  const infoClient = {
    async fetchUserGoldFills(address, range) {
      assert.equal(address, ADDRESS);
      assert.ok(range.startTime < range.endTime);
      return fills;
    },
    async fetchGoldPosition(address) {
      assert.equal(address, ADDRESS);
      return {
        side: 'LONG',
        size: 2.5,
        signedSize: 2.5,
        entryPrice: 4039.5,
        positionValue: 10098.75,
        unrealizedPnl: 12.5,
      };
    },
  };
  const logs = [];
  const observer = createCandidateObserver({
    database,
    infoClient,
    now: () => now,
    logger: (entry) => logs.push(entry),
    maxCandidates: 5,
  });

  assert.deepEqual(await observer.runOnce(), {
    reviewed: 1,
    qualified: 1,
    excluded: 0,
    waiting: 0,
    failed: 0,
  });

  const wallet = database.getWallet(ADDRESS);
  assert.equal(wallet.status, 'QUALIFIED');
  assert.equal(wallet.positionSide, 'LONG');
  assert.equal(wallet.positionSize, 2.5);
  assert.equal(wallet.positionEntryPrice, 4039.5);
  assert.equal(database.listFills(ADDRESS).length, 6);
  assert.equal(database.listEpisodes(ADDRESS, { completeOnly: true }).length, 3);
  assert.ok(wallet.nextReviewAt >= now + (55 * 60 * 1000));
  assert.equal(logs.some((entry) => 'address' in entry), false);
});

test('candidate failures are isolated and returned without wallet identifiers', async (t) => {
  const now = 500_000;
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => now });
  t.after(() => database.close());
  database.importSeeds([ADDRESS]);
  const observer = createCandidateObserver({
    database,
    infoClient: {
      async fetchUserGoldFills() {
        throw new Error('upstream unavailable for private address');
      },
      async fetchGoldPosition() {
        return null;
      },
    },
    now: () => now,
    logger: () => {},
  });

  const result = await observer.runOnce();
  assert.equal(result.failed, 1);
  assert.equal(JSON.stringify(result).includes(ADDRESS), false);
  assert.ok(database.getWallet(ADDRESS).nextReviewAt > now);
});
