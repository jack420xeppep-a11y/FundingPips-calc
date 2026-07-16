import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntelligenceDatabase } from './database.js';
import {
  buildCohortMemberships,
  createCohortRotator,
  decideWalletLifecycle,
  scoreWalletEpisodes,
} from './cohorts.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const DAY = 24 * 60 * 60 * 1000;

const episode = (overrides = {}) => ({
  address: ADDRESS,
  side: 'LONG',
  openedAt: 1000,
  closedAt: 1000 + (60 * 60 * 1000),
  entryPrice: 4000,
  exitPrice: 4020,
  peakSize: 2,
  closedPnl: 40,
  holdMs: 60 * 60 * 1000,
  mfeBps: 60,
  maeBps: -20,
  capturedBps: 50,
  fillCount: 4,
  aggressiveRatio: 0.5,
  session: 'LONDON',
  regime: 'BREAKOUT',
  targetBand: '0.35-0.60%',
  complete: true,
  historyTruncated: false,
  ...overrides,
});

test('wallet score rewards consistent evidence and penalizes lucky concentration', () => {
  const now = 200 * DAY;
  const consistent = Array.from({ length: 20 }, (_, index) => episode({
    openedAt: now - ((20 - index) * DAY),
    closedAt: now - ((20 - index) * DAY) + 60 * 60 * 1000,
    side: index % 4 === 0 ? 'SHORT' : 'LONG',
    closedPnl: index % 5 === 0 ? -15 : 30,
    capturedBps: index % 5 === 0 ? -18 : 42,
    session: index % 2 === 0 ? 'LONDON' : 'NEW_YORK',
  }));
  const lucky = [
    ...Array.from({ length: 9 }, (_, index) => episode({
      openedAt: now - ((10 - index) * DAY),
      closedAt: now - ((10 - index) * DAY) + 1000,
      closedPnl: -1,
      capturedBps: -1,
    })),
    episode({
      openedAt: now - DAY,
      closedAt: now - DAY + 1000,
      closedPnl: 500,
      capturedBps: 200,
    }),
  ];

  const consistentScore = scoreWalletEpisodes(consistent, { now });
  const luckyScore = scoreWalletEpisodes(lucky, { now });
  assert.equal(consistentScore.episodeCount, 20);
  assert.ok(consistentScore.profitFactor > 2);
  assert.ok(consistentScore.wilsonLower > 0.55);
  assert.ok(consistentScore.antiLuck > luckyScore.antiLuck);
  assert.ok(consistentScore.overallScore > luckyScore.overallScore);
  assert.ok(consistentScore.longQuality > 0.5);
  assert.ok(consistentScore.shortQuality >= 0);
});

test('cohorts overlap by horizon, side, session, regime, target, and whale size', () => {
  const now = 300 * DAY;
  const episodes = Array.from({ length: 12 }, (_, index) => episode({
    openedAt: now - ((12 - index) * DAY),
    closedAt: now - ((12 - index) * DAY) + (45 * 60 * 1000),
    side: index < 9 ? 'SHORT' : 'LONG',
    closedPnl: index === 10 ? -10 : 35,
    session: index % 3 === 0 ? 'NEW_YORK' : 'LONDON',
    regime: index % 4 === 0 ? 'REVERSAL' : 'BREAKOUT',
    targetBand: index % 2 === 0 ? '0.20-0.35%' : '0.35-0.60%',
  }));
  const score = scoreWalletEpisodes(episodes, { now });
  const memberships = buildCohortMemberships({
    episodes,
    score,
    currentPosition: {
      side: 'SHORT',
      positionValue: 100_000,
    },
  });
  const names = memberships.map(({ cohort }) => cohort);

  assert.ok(names.includes('INTRADAY_DIRECTIONAL'));
  assert.ok(names.includes('SIDE_SHORT'));
  assert.ok(names.includes('SESSION_LONDON'));
  assert.ok(names.includes('REGIME_BREAKOUT'));
  assert.ok(names.includes('TARGET_0_20_0_35'));
  assert.ok(names.includes('WHALE_CONVICTION_SHORT'));
  assert.equal(new Set(names).size, names.length);
});

test('lifecycle applies activation and probation hysteresis', () => {
  const now = 500 * DAY;
  assert.deepEqual(decideWalletLifecycle({
    wallet: { status: 'QUALIFIED', updatedAt: now - DAY },
    score: { episodeCount: 10, overallScore: 0.62 },
    membershipCount: 4,
    now,
  }), {
    nextStatus: 'ACTIVE_COHORT',
    reason: 'qualified evidence passed active cohort threshold',
  });

  assert.deepEqual(decideWalletLifecycle({
    wallet: { status: 'ACTIVE_COHORT', updatedAt: now - DAY },
    score: { episodeCount: 12, overallScore: 0.4 },
    membershipCount: 3,
    now,
  }), {
    nextStatus: 'PROBATION',
    reason: 'active score fell below probation threshold',
  });

  assert.equal(decideWalletLifecycle({
    wallet: { status: 'PROBATION', updatedAt: now - (12 * 60 * 60 * 1000) },
    score: { episodeCount: 12, overallScore: 0.3 },
    membershipCount: 1,
    now,
  }).nextStatus, 'PROBATION');

  assert.equal(decideWalletLifecycle({
    wallet: { status: 'PROBATION', updatedAt: now - (2 * DAY) },
    score: { episodeCount: 12, overallScore: 0.3 },
    membershipCount: 1,
    now,
  }).nextStatus, 'RETIRED');
});

test('cohort database preserves membership history and current score', (t) => {
  const now = 600 * DAY;
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => now });
  t.after(() => database.close());
  database.importSeeds([ADDRESS]);
  database.transitionWallet(ADDRESS, 'OBSERVED', { reason: 'test', at: now - 3000 });
  database.transitionWallet(ADDRESS, 'QUALIFIED', { reason: 'test', at: now - 2000 });

  const score = {
    calculatedAt: now,
    episodeCount: 10,
    winRate: 0.7,
    wilsonLower: 0.5,
    profitFactor: 2,
    sharpe: 1.2,
    ewmaQuality: 0.7,
    antiLuck: 0.8,
    longQuality: 0.75,
    shortQuality: 0.55,
    overallScore: 0.68,
  };
  database.saveWalletScore(ADDRESS, score);
  database.replaceCohortMemberships(ADDRESS, [
    { cohort: 'INTRADAY_DIRECTIONAL', score: 0.7, reason: 'hold time matched' },
    { cohort: 'SIDE_LONG', score: 0.75, reason: 'long quality matched' },
  ], { at: now });
  database.replaceCohortMemberships(ADDRESS, [
    { cohort: 'SIDE_LONG', score: 0.8, reason: 'long quality refreshed' },
    { cohort: 'SESSION_LONDON', score: 0.65, reason: 'session matched' },
  ], { at: now + 1000 });

  assert.equal(database.getWalletScore(ADDRESS).overallScore, 0.68);
  assert.deepEqual(database.listCohortMemberships(ADDRESS, { activeOnly: true })
    .map(({ cohort }) => cohort), ['SESSION_LONDON', 'SIDE_LONG']);
  const history = database.listCohortMemberships(ADDRESS, { activeOnly: false });
  assert.equal(history.find(({ cohort }) => cohort === 'INTRADAY_DIRECTIONAL').endedAt, now + 1000);
});

test('cohort rotator promotes a qualified wallet and writes memberships', async (t) => {
  const now = 700 * DAY;
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => now });
  t.after(() => database.close());
  database.importSeeds([ADDRESS]);
  database.transitionWallet(ADDRESS, 'OBSERVED', { reason: 'test', at: now - 3000 });
  database.transitionWallet(ADDRESS, 'QUALIFIED', { reason: 'test', at: now - 2000 });

  const episodes = Array.from({ length: 10 }, (_, index) => episode({
    openedAt: now - ((10 - index) * DAY),
    closedAt: now - ((10 - index) * DAY) + (60 * 60 * 1000),
    closedPnl: index % 5 === 0 ? -10 : 40,
    side: index % 4 === 0 ? 'SHORT' : 'LONG',
  }));
  database.replaceEpisodes(ADDRESS, episodes);
  database.recordGoldPosition(ADDRESS, {
    side: 'LONG',
    size: 20,
    entryPrice: 4000,
    positionValue: 80_000,
    unrealizedPnl: 100,
  }, { at: now });

  const rotator = createCohortRotator({ database, now: () => now });
  assert.deepEqual(await rotator.runOnce(), {
    reviewed: 1,
    activated: 1,
    probation: 0,
    retired: 0,
    unchanged: 0,
    failed: 0,
  });
  assert.equal(database.getWallet(ADDRESS).status, 'ACTIVE_COHORT');
  assert.ok(database.listCohortMemberships(ADDRESS, { activeOnly: true }).length >= 3);
});
