import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntelligenceDatabase } from './database.js';
import {
  buildPhaseAwareRecommendation,
  buildWalletSignal,
  createRecommendationStabilizer,
} from './probability-engine.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1784194000000;

const snapshot = (overrides = {}) => ({
  status: 'live',
  generatedAt: NOW,
  market: {
    session: 'LONDON',
    basisBps: -1,
    hyperliquid: {
      mid: 4035,
      mark: 4035,
      oracle: 4035.5,
      openInterest: 30000,
      funding: 0,
      premium: 0,
      stale: false,
    },
    bybit: {
      mid: 4035,
      bid: 4034.9,
      ask: 4035.1,
      timestamp: NOW,
      stale: false,
    },
  },
  features: {
    aggressiveFlow5m: -0.6,
    aggressiveFlow15m: -0.55,
    aggressiveFlow60m: -0.4,
    bookImbalance: -0.45,
    momentum5mBps: -20,
    momentum15mBps: -35,
    volatilityBps: 9,
    openInterestChangePct: 0.2,
  },
  ...overrides,
});

const wallet = ({
  address,
  side = 'SHORT',
  overallScore = 0.75,
  episodeCount = 20,
  entryPrice = 4035,
  updatedAt = NOW - 60_000,
  memberships = [
    'INTRADAY_DIRECTIONAL',
    'SIDE_SHORT',
    'SESSION_LONDON',
    'REGIME_BREAKOUT',
    'TARGET_0_20_0_35',
  ],
} = {}) => ({
  address,
  status: 'ACTIVE_COHORT',
  positionSide: side,
  positionSize: 10,
  positionEntryPrice: entryPrice,
  positionValue: 40_000,
  positionUpdatedAt: updatedAt,
  score: {
    episodeCount,
    overallScore,
    longQuality: side === 'LONG' ? overallScore : 0.4,
    shortQuality: side === 'SHORT' ? overallScore : 0.4,
  },
  memberships: memberships.map((cohort) => ({ cohort, score: overallScore })),
});

test('wallet signal matches context and discounts correlated wallets', () => {
  const wallets = [
    wallet({ address: '0x1111111111111111111111111111111111111111' }),
    wallet({ address: '0x2222222222222222222222222222222222222222' }),
    wallet({
      address: '0x3333333333333333333333333333333333333333',
      side: 'LONG',
      entryPrice: 4020,
      overallScore: 0.6,
      memberships: ['INTRADAY_DIRECTIONAL', 'SIDE_LONG', 'SESSION_ASIA'],
    }),
  ];
  const signal = buildWalletSignal({
    wallets,
    session: 'LONDON',
    regime: 'BREAKOUT',
    targetBand: '0.20-0.35%',
    now: NOW,
  });

  assert.ok(signal.probabilityDown > 0.7);
  assert.equal(signal.cohortSize, 3);
  assert.ok(signal.maturity > 0);
  assert.ok(signal.reasons.some((reason) => /SHORT/.test(reason)));
  assert.equal(JSON.stringify(signal).includes('0x111111'), false);
  assert.ok(signal.diagnostics.clusterCount < signal.cohortSize);
});

test('wallet signal stays neutral when no verified active cohort exists', () => {
  assert.deepEqual(buildWalletSignal({
    wallets: [],
    session: 'LONDON',
    regime: 'RANGE',
    targetBand: '0.20-0.35%',
    now: NOW,
  }), {
    status: 'warming',
    probabilityUp: 0.5,
    probabilityDown: 0.5,
    confidence: 0,
    maturity: 0,
    cohortSize: 0,
    reasons: ['verified wallet cohort is still warming'],
    diagnostics: {
      clusterCount: 0,
      totalEpisodeCount: 0,
      freshnessFactor: 0,
    },
  });
});

test('phase-aware engine recommends the paired orientation for user intent', () => {
  const wallets = [
    wallet({ address: '0x1111111111111111111111111111111111111111' }),
    wallet({ address: '0x2222222222222222222222222222222222222222', entryPrice: 4034 }),
    wallet({ address: '0x3333333333333333333333333333333333333333', entryPrice: 4032 }),
  ];
  const setup = {
    entryPrice: 4035,
    slPct: 0.25,
    rrRatio: 2,
    stage: 'p1',
    accountSize: 10_000,
    riskPerTrade: 2,
    fundedRisk: 1,
    profitSplit: 0.8,
    bybitStake: 25,
  };
  const metrics = { resolvedCount: 100, brierScore: 0.12 };

  const bybitIntent = buildPhaseAwareRecommendation({
    snapshot: snapshot(),
    setup,
    wallets,
    modelMetrics: metrics,
    intent: 'transfer-to-bybit',
  });
  assert.equal(bybitIntent.recommendation.fpDirection, 'long');
  assert.equal(bybitIntent.recommendation.bybitDirection, 'SHORT');
  assert.ok(bybitIntent.paths.down.probability > bybitIntent.paths.up.probability);
  assert.equal(bybitIntent.paths.down.label, 'BB TP / FP SL');
  assert.ok(bybitIntent.marketSignal >= 0 && bybitIntent.marketSignal <= 1);
  assert.ok(bybitIntent.walletSignal >= 0 && bybitIntent.walletSignal <= 1);
  assert.ok(bybitIntent.maturity > 0);

  const fpIntent = buildPhaseAwareRecommendation({
    snapshot: snapshot(),
    setup,
    wallets,
    modelMetrics: metrics,
    intent: 'transfer-to-fundingpips',
  });
  assert.equal(fpIntent.recommendation.fpDirection, 'short');
  assert.equal(fpIntent.recommendation.bybitDirection, 'LONG');
});

test('best-EV output is phase aware and explicitly fee-free', () => {
  const common = {
    snapshot: snapshot(),
    wallets: [wallet({ address: '0x1111111111111111111111111111111111111111' })],
    modelMetrics: { resolvedCount: 300, brierScore: 0.1 },
    intent: 'best-expected-value',
  };
  const baseSetup = {
    entryPrice: 4035,
    slPct: 0.25,
    rrRatio: 2,
    accountSize: 10_000,
    riskPerTrade: 2,
    fundedRisk: 1,
    profitSplit: 0.8,
    bybitStake: 25,
  };
  const phaseOne = buildPhaseAwareRecommendation({
    ...common,
    setup: { ...baseSetup, stage: 'p1' },
  });
  const funded = buildPhaseAwareRecommendation({
    ...common,
    setup: { ...baseSetup, stage: 'funded', bybitStake: 45 },
  });
  assert.notEqual(
    phaseOne.candidates.long.expectedValueUsdEquivalent,
    funded.candidates.long.expectedValueUsdEquivalent,
  );
  assert.equal(phaseOne.economics.includesFeesOrSpread, false);
  assert.equal(phaseOne.economics.executionEnabled, false);
});

test('range without directional edge returns NO EDGE and disables AUTO', () => {
  const neutral = snapshot({
    features: {
      aggressiveFlow5m: 0,
      aggressiveFlow15m: 0,
      aggressiveFlow60m: 0,
      bookImbalance: 0,
      momentum5mBps: 0,
      momentum15mBps: 0,
      volatilityBps: 2,
      openInterestChangePct: 0,
    },
  });
  const result = buildPhaseAwareRecommendation({
    snapshot: neutral,
    setup: {
      entryPrice: 4035,
      slPct: 0.25,
      rrRatio: 1,
      stage: 'p1',
      accountSize: 10_000,
      riskPerTrade: 2,
      fundedRisk: 1,
      profitSplit: 0.8,
      bybitStake: 25,
    },
    wallets: [],
    modelMetrics: { resolvedCount: 0, brierScore: null },
    intent: 'transfer-to-bybit',
  });
  assert.equal(result.status, 'no_edge');
  assert.equal(result.recommendation.autoEligible, false);
});

test('recommendation stabilizer requires confirmation and enforces switch cooldown', () => {
  let clock = 1000;
  const stabilizer = createRecommendationStabilizer({
    now: () => clock,
    minimumConsecutive: 3,
    cooldownMs: 10_000,
  });
  const long = { status: 'ready', recommendation: { fpDirection: 'long', autoEligible: true } };
  const short = { status: 'ready', recommendation: { fpDirection: 'short', autoEligible: true } };

  assert.equal(stabilizer.update(long).stable, false);
  assert.equal(stabilizer.update(long).stable, false);
  assert.deepEqual(stabilizer.update(long), {
    stable: true,
    direction: 'long',
    changed: true,
    switchAllowedAt: 11_000,
  });
  clock = 2000;
  stabilizer.update(short);
  stabilizer.update(short);
  assert.equal(stabilizer.update(short).direction, 'long');
  clock = 12_000;
  stabilizer.update(short);
  stabilizer.update(short);
  assert.equal(stabilizer.update(short).direction, 'short');
});

test('private database query returns active signal inputs only to backend code', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => NOW });
  t.after(() => database.close());
  const address = '0x1111111111111111111111111111111111111111';
  database.importSeeds([address]);
  database.transitionWallet(address, 'OBSERVED', { reason: 'test', at: NOW - 4000 });
  database.transitionWallet(address, 'QUALIFIED', { reason: 'test', at: NOW - 3000 });
  database.transitionWallet(address, 'ACTIVE_COHORT', { reason: 'test', at: NOW - 2000 });
  database.recordGoldPosition(address, {
    side: 'SHORT',
    size: 10,
    entryPrice: 4035,
    positionValue: 40_350,
    unrealizedPnl: 20,
  }, { at: NOW - 1000 });
  database.saveWalletScore(address, {
    calculatedAt: NOW,
    episodeCount: 20,
    winRate: 0.7,
    wilsonLower: 0.5,
    profitFactor: 2,
    sharpe: 1,
    ewmaQuality: 0.7,
    antiLuck: 0.8,
    longQuality: 0.4,
    shortQuality: 0.75,
    overallScore: 0.7,
  });
  database.replaceCohortMemberships(address, [
    { cohort: 'SIDE_SHORT', score: 0.75, reason: 'verified' },
  ], { at: NOW });

  const signals = database.listActiveWalletSignals();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].address, address);
  assert.equal(signals[0].score.shortQuality, 0.75);
  assert.deepEqual(signals[0].memberships.map(({ cohort }) => cohort), ['SIDE_SHORT']);
});
