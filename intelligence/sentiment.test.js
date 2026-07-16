import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarketSentiment,
  createMarketSentimentAggregator,
} from './sentiment.js';

const baseSnapshot = (overrides = {}) => ({
  status: 'live',
  generatedAt: 1784194000000,
  market: {
    session: 'LONDON',
    basisBps: -4,
    hyperliquid: {
      premium: 0.0004,
      stale: false,
    },
    bybit: {
      stale: false,
    },
  },
  features: {
    momentum5mBps: -24,
    momentum15mBps: -38,
    aggressiveFlow5m: -0.58,
    aggressiveFlow15m: -0.52,
    bookImbalanceEma: -0.46,
    openInterestChange5mPct: 0.22,
    openInterestChange15mPct: 0.48,
    volatilityBps: 12,
  },
  ...overrides,
});

test('market sentiment is bounded, weighted, and directionally coherent', () => {
  const result = buildMarketSentiment(baseSnapshot());

  assert.equal(result.status, 'ready');
  assert.equal(result.direction, 'SHORT');
  assert.ok(result.score <= -55 && result.score >= -100);
  assert.equal(
    Object.values(result.components).reduce((sum, component) => sum + component.weight, 0),
    100,
  );
  assert.ok(Object.values(result.components).every(
    (component) => component.value >= -component.weight &&
      component.value <= component.weight,
  ));
  assert.ok(result.reasons.length >= 2);
});

test('market sentiment reverses symmetrically and reports stale input', () => {
  const long = buildMarketSentiment(baseSnapshot({
    market: {
      ...baseSnapshot().market,
      basisBps: 4,
      hyperliquid: {
        premium: -0.0004,
        stale: false,
      },
    },
    features: {
      ...baseSnapshot().features,
      momentum5mBps: 24,
      momentum15mBps: 38,
      aggressiveFlow5m: 0.58,
      aggressiveFlow15m: 0.52,
      bookImbalanceEma: 0.46,
    },
  }));
  assert.equal(long.direction, 'LONG');
  assert.ok(long.score >= 55);

  const stale = buildMarketSentiment(baseSnapshot({
    status: 'stale',
  }));
  assert.equal(stale.status, 'stale');
  assert.equal(stale.direction, 'NEUTRAL');
  assert.equal(stale.score, null);
});

test('market sentiment aggregator publishes only every 15 seconds and tracks stable age', () => {
  let clock = 1784194000000;
  const aggregator = createMarketSentimentAggregator({
    now: () => clock,
    publishIntervalMs: 15_000,
  });

  const first = aggregator.update(baseSnapshot({ generatedAt: clock }));
  assert.equal(first.published, true);
  assert.equal(first.sentiment.direction, 'SHORT');
  assert.equal(first.sentiment.stableForMs, 0);

  clock += 5_000;
  const skipped = aggregator.update(baseSnapshot({
    generatedAt: clock,
    features: {
      ...baseSnapshot().features,
      momentum5mBps: 1,
      momentum15mBps: 1,
      aggressiveFlow5m: 0,
      aggressiveFlow15m: 0,
      bookImbalanceEma: 0,
    },
  }));
  assert.equal(skipped.published, false);
  assert.equal(skipped.sentiment.direction, 'SHORT');

  clock += 10_000;
  const second = aggregator.update(baseSnapshot({ generatedAt: clock }));
  assert.equal(second.published, true);
  assert.equal(second.sentiment.direction, 'SHORT');
  assert.equal(second.sentiment.stableForMs, 15_000);
});
