import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntelligenceDatabase } from './database.js';
import {
  buildBarrierDefinition,
  buildMarketOnlyForecast,
  classifyMarketRegime,
  createPredictionRecord,
} from './market-model.js';

const baseSnapshot = (featureOverrides = {}) => ({
  status: 'live',
  generatedAt: 1784194000000,
  market: {
    session: 'LONDON',
    basisBps: 1.2,
    hyperliquid: {
      mid: 4035.5,
      mark: 4035.6,
      oracle: 4033.6,
      openInterest: 33299,
      funding: 0.00000625,
      premium: 0.00048,
      stale: false,
    },
    bybit: {
      mid: 4035,
      bid: 4034.9,
      ask: 4035.1,
      timestamp: 1784194000000,
      stale: false,
    },
  },
  features: {
    aggressiveFlow5m: 0.5,
    aggressiveFlow15m: 0.45,
    aggressiveFlow60m: 0.2,
    bookImbalance: 0.35,
    momentum5mBps: 18,
    momentum15mBps: 32,
    volatilityBps: 8,
    openInterestChangePct: 0.2,
    ...featureOverrides,
  },
});

test('market regime distinguishes breakout, reversal, and range', () => {
  assert.equal(classifyMarketRegime(baseSnapshot()).regime, 'BREAKOUT');
  assert.equal(classifyMarketRegime(baseSnapshot({
    aggressiveFlow15m: -0.6,
    bookImbalance: -0.5,
  })).regime, 'REVERSAL');
  assert.equal(classifyMarketRegime(baseSnapshot({
    aggressiveFlow5m: 0.01,
    aggressiveFlow15m: 0.01,
    aggressiveFlow60m: 0,
    bookImbalance: 0.02,
    momentum5mBps: 1,
    momentum15mBps: 2,
    volatilityBps: 2,
    openInterestChangePct: 0,
  })).regime, 'RANGE');
});

test('barriers map the paired Bybit/FP outcomes for both directions', () => {
  assert.deepEqual(buildBarrierDefinition({
    entryPrice: 4000,
    slPct: 0.25,
    rrRatio: 2,
    fpDirection: 'long',
    horizonMs: 4 * 60 * 60 * 1000,
    createdAt: 1000,
  }), {
    entryPrice: 4000,
    upBarrier: 4020,
    downBarrier: 3990,
    upPath: 'BYBIT_SL_FP_TP',
    downPath: 'BYBIT_TP_FP_SL',
    expiresAt: 14_401_000,
  });
  assert.deepEqual(buildBarrierDefinition({
    entryPrice: 4000,
    slPct: 0.25,
    rrRatio: 2,
    fpDirection: 'short',
    horizonMs: 4 * 60 * 60 * 1000,
    createdAt: 1000,
  }), {
    entryPrice: 4000,
    upBarrier: 4010,
    downBarrier: 3980,
    upPath: 'BYBIT_TP_FP_SL',
    downPath: 'BYBIT_SL_FP_TP',
    expiresAt: 14_401_000,
  });
});

test('market-only forecast is normalized, directional, and barrier-aware', () => {
  const longForecast = buildMarketOnlyForecast({
    snapshot: baseSnapshot(),
    setup: {
      entryPrice: 4035,
      slPct: 0.25,
      rrRatio: 2,
      fpDirection: 'long',
    },
  });
  const shortForecast = buildMarketOnlyForecast({
    snapshot: baseSnapshot(),
    setup: {
      entryPrice: 4035,
      slPct: 0.25,
      rrRatio: 2,
      fpDirection: 'short',
    },
  });

  for (const forecast of [longForecast, shortForecast]) {
    const sum = forecast.probabilities.up +
      forecast.probabilities.down +
      forecast.probabilities.neither;
    assert.ok(Math.abs(sum - 1) < 1e-8);
    assert.equal(forecast.status, 'ready');
    assert.equal(forecast.regime, 'BREAKOUT');
    assert.ok(forecast.probabilities.up > forecast.probabilities.down);
    assert.ok(forecast.confidence >= 0 && forecast.confidence <= 1);
    assert.ok(forecast.reasons.length >= 2);
  }
  assert.ok(shortForecast.probabilities.up > longForecast.probabilities.up);

  const downForecast = buildMarketOnlyForecast({
    snapshot: baseSnapshot({
      aggressiveFlow5m: -0.7,
      aggressiveFlow15m: -0.7,
      aggressiveFlow60m: -0.4,
      bookImbalance: -0.6,
      momentum5mBps: -25,
      momentum15mBps: -40,
      openInterestChangePct: 0.3,
    }),
    setup: {
      entryPrice: 4035,
      slPct: 0.25,
      rrRatio: 2,
      fpDirection: 'long',
    },
  });
  assert.ok(downForecast.probabilities.down > downForecast.probabilities.up);
});

test('four-hour touch model does not claim near-certain no-touch for a close gold barrier', () => {
  const forecast = buildMarketOnlyForecast({
    snapshot: baseSnapshot({
      aggressiveFlow5m: 0.01,
      aggressiveFlow15m: 0.01,
      aggressiveFlow60m: 0,
      bookImbalance: 0.01,
      momentum5mBps: 0.5,
      momentum15mBps: 1,
      volatilityBps: 0.5,
      openInterestChangePct: 0,
    }),
    setup: {
      entryPrice: 4035,
      slPct: 0.22,
      rrRatio: 2,
      fpDirection: 'long',
    },
    horizonMs: 4 * 60 * 60 * 1000,
  });

  assert.ok(forecast.probabilities.neither < 0.85);
  assert.ok(forecast.probabilities.up + forecast.probabilities.down > 0.15);
});

test('outcome labels use only future Bybit MID and update calibration metrics', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => 1000 });
  t.after(() => database.close());
  const forecast = buildMarketOnlyForecast({
    snapshot: baseSnapshot(),
    setup: {
      entryPrice: 4000,
      slPct: 0.25,
      rrRatio: 2,
      fpDirection: 'long',
    },
  });
  const prediction = createPredictionRecord({
    forecast,
    setup: {
      entryPrice: 4000,
      slPct: 0.25,
      rrRatio: 2,
      fpDirection: 'long',
      stage: 'p1',
    },
    createdAt: 1000,
    horizonMs: 10_000,
  });
  assert.equal(database.recordPrediction(prediction), 1);
  assert.equal(database.recordPrediction(prediction), 0);

  assert.deepEqual(database.resolvePredictionsWithPrice({
    timestamp: 999,
    bybitMid: 3980,
  }), { resolved: 0, down: 0, up: 0, neither: 0 });
  assert.deepEqual(database.resolvePredictionsWithPrice({
    timestamp: 2000,
    bybitMid: 3989,
  }), { resolved: 1, down: 1, up: 0, neither: 0 });

  const stored = database.listPredictions({ resolvedOnly: true });
  assert.equal(stored[0].outcome, 'DOWN');
  assert.equal(stored[0].outcomeAt, 2000);
  const metrics = database.getModelMetrics();
  assert.equal(metrics.resolvedCount, 1);
  assert.ok(metrics.brierScore >= 0 && metrics.brierScore <= 1);
  assert.ok(metrics.calibration.length >= 1);
});

test('expiry resolves neither and counterfactual records remain independent', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => 1000 });
  t.after(() => database.close());
  const setupBase = {
    entryPrice: 4000,
    slPct: 0.25,
    rrRatio: 2,
    stage: 'p1',
  };
  for (const fpDirection of ['long', 'short']) {
    const forecast = buildMarketOnlyForecast({
      snapshot: baseSnapshot(),
      setup: { ...setupBase, fpDirection },
    });
    database.recordPrediction(createPredictionRecord({
      forecast,
      setup: { ...setupBase, fpDirection },
      createdAt: 1000,
      horizonMs: 5_000,
    }));
  }
  assert.deepEqual(database.resolvePredictionsWithPrice({
    timestamp: 6001,
    bybitMid: 4000,
  }), { resolved: 2, down: 0, up: 0, neither: 2 });
  assert.deepEqual(
    database.listPredictions({ resolvedOnly: true }).map(({ fpDirection, outcome }) => ({
      fpDirection,
      outcome,
    })),
    [
      { fpDirection: 'long', outcome: 'NEITHER' },
      { fpDirection: 'short', outcome: 'NEITHER' },
    ],
  );
});
