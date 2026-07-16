import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntelligenceDatabase } from './database.js';
import { createGoldIntelligenceRuntime } from './runtime.js';

const NOW = 1784194000000;

const marketSnapshot = {
  version: 1,
  status: 'live',
  generatedAt: NOW,
  staleAfterMs: 15_000,
  market: {
    coin: 'xyz:GOLD',
    session: 'LONDON',
    basisBps: -1,
    hyperliquid: {
      bid: 4034.9,
      ask: 4035.1,
      mid: 4035,
      mark: 4035,
      oracle: 4035.5,
      openInterest: 30000,
      funding: 0,
      premium: 0,
      dayNotionalVolume: 10_000_000,
      timestamp: NOW,
      stale: false,
    },
    bybit: {
      instrument: 'XAUUSD',
      bybitSymbol: 'XAUUSD+',
      bid: 4034.9,
      ask: 4035.1,
      mid: 4035,
      timestamp: NOW,
      stale: false,
    },
  },
  features: {
    aggressiveFlow5m: -0.5,
    aggressiveFlow15m: -0.5,
    aggressiveFlow60m: -0.3,
    bookImbalance: -0.4,
    momentum5mBps: -20,
    momentum15mBps: -35,
    volatilityBps: 8,
    openInterestChangePct: 0.2,
  },
  diagnostics: {
    recentTradeCount: 10,
    priceSampleCount: 20,
    dedupeKeyCount: 10,
  },
};

const setup = {
  instrument: 'XAUUSD',
  entryPrice: 4035,
  slPct: 0.25,
  rrRatio: 2,
  stage: 'p1',
  accountSize: 10_000,
  riskPerTrade: 2,
  fundedRisk: 1,
  profitSplit: 0.8,
  bybitStake: 25,
  intent: 'transfer-to-bybit',
};

test('runtime returns only aggregate model state and records both shadow directions', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => NOW });
  t.after(() => database.close());
  const listeners = new Set();
  const marketStore = {
    snapshot: () => marketSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const runtime = createGoldIntelligenceRuntime({
    database,
    marketStore,
    now: () => NOW,
  });
  t.after(() => runtime.close());

  const result = runtime.getPublicSnapshot(setup);
  assert.equal(result.version, 1);
  assert.equal(result.market.symbol, 'xyz:GOLD');
  assert.equal(result.market.bybitSymbol, 'XAUUSD+');
  assert.equal(result.economics.executionEnabled, false);
  assert.equal(JSON.stringify(result).includes('address'), false);
  assert.equal(database.listPredictions().length, 2);
  runtime.getPublicSnapshot(setup);
  assert.equal(database.listPredictions().length, 2);

  let updates = 0;
  const unsubscribe = runtime.subscribe(() => {
    updates += 1;
  });
  for (const listener of listeners) listener(marketSnapshot);
  assert.equal(updates, 1);
  unsubscribe();
});

test('runtime health is sanitized, bounded, and reports model maturity', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:', now: () => NOW });
  t.after(() => database.close());
  const runtime = createGoldIntelligenceRuntime({
    database,
    marketStore: {
      snapshot: () => marketSnapshot,
      subscribe: () => () => {},
    },
    now: () => NOW,
    jobState: {
      observer: { lastRunAt: NOW - 1000, status: 'ok' },
      cohorts: { lastRunAt: NOW - 1000, status: 'ok' },
      retention: { lastRunAt: NOW - 1000, status: 'ok' },
    },
  });
  t.after(() => runtime.close());

  const health = runtime.getPublicHealth();
  assert.equal(health.status, 'live');
  assert.equal(health.database.schemaVersion, 1);
  assert.equal(health.database.rows.wallets, 0);
  assert.equal(health.model.resolvedCount, 0);
  assert.equal(JSON.stringify(health).includes(':memory:'), false);
  assert.equal(JSON.stringify(health).includes('seed'), false);
});
