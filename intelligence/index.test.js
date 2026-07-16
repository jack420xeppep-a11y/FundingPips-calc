import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMarketPersistence,
  createStructuredLogger,
} from './index.js';

const NOW = 1784194000000;

test('market persistence stores bounded live samples and resolves Bybit outcomes', () => {
  const calls = [];
  const persistence = createMarketPersistence({
    database: {
      recordTrades(trades) {
        calls.push(['trades', trades.length]);
      },
      recordMarketSample(sample) {
        calls.push(['sample', sample]);
      },
      resolvePredictionsWithPrice(quote) {
        calls.push(['resolve', quote]);
      },
    },
    sampleIntervalMs: 60_000,
    logger: () => {},
  });

  persistence.recordTrades([{ coin: 'xyz:GOLD' }]);
  const snapshot = {
    status: 'live',
    generatedAt: NOW,
    market: {
      session: 'LONDON',
      basisBps: 1.25,
      hyperliquid: {
        mid: 4035.5,
        mark: 4035.4,
        oracle: 4035.2,
        openInterest: 32000,
        funding: 0.00001,
        premium: 0.0002,
      },
      bybit: { mid: 4035 },
    },
    features: {
      aggressiveFlow5m: 0.1,
      aggressiveFlow15m: 0.2,
      aggressiveFlow60m: -0.1,
      bookImbalance: 0.3,
      momentum5mBps: 2,
      momentum15mBps: 4,
      volatilityBps: 5,
      openInterestChangePct: 0.2,
    },
  };
  persistence.recordSnapshot(snapshot);
  persistence.recordSnapshot({ ...snapshot, generatedAt: NOW + 30_000 });
  persistence.recordSnapshot({ ...snapshot, generatedAt: NOW + 60_000 });
  persistence.resolveQuote({
    instrument: 'XAUUSD',
    bybitSymbol: 'XAUUSD+',
    bid: 4034.9,
    ask: 4035.1,
    mid: 4035,
    timestamp: NOW + 1,
    stale: false,
  });

  assert.deepEqual(calls.map(([kind]) => kind), [
    'trades',
    'sample',
    'sample',
    'resolve',
  ]);
  assert.equal(calls[1][1].session, 'LONDON');
  assert.equal(calls[1][1].hyperliquidMid, 4035.5);
  assert.deepEqual(calls[3][1], {
    timestamp: NOW + 1,
    bybitMid: 4035,
  });
});

test('structured logger emits only an explicit safe aggregate schema', () => {
  const output = [];
  const logger = createStructuredLogger({
    write: (line) => output.push(line),
    now: () => NOW,
  });
  logger({
    event: 'candidate_observation_failed',
    errorType: 'TimeoutError',
    timestamp: NOW - 1,
    address: '0x1111111111111111111111111111111111111111',
    message: 'private upstream payload',
    result: { reviewed: 2 },
  });

  assert.equal(output.length, 1);
  const entry = JSON.parse(output[0]);
  assert.deepEqual(entry, {
    service: 'calcpro-gold-intelligence',
    event: 'candidate_observation_failed',
    timestamp: NOW - 1,
    errorType: 'TimeoutError',
  });
  assert.doesNotMatch(output[0], /0x[0-9a-f]{40}|private upstream/i);
});
