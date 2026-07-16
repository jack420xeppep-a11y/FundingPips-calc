import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TRADE_SNAPSHOT_STORAGE_KEY,
  clearTradeSnapshot,
  createTradeSnapshot,
  loadTradeSnapshot,
  persistTradeSnapshot,
  resolveTradeView,
} from './tradeSnapshot.js';

const NOW = 1784194000000;

const position = {
  status: 'ready',
  stage: 'Phase 1',
  decimals: 2,
  actualSlPct: 0.206,
  stake: 25,
  bybit: {
    platform: 'BYBIT',
    direction: 'LONG',
    lots: 0.31,
    takeProfit: 4038,
    stopLoss: 4027,
    takeProfitPnl: 25,
    stopLossPnl: -50,
  },
  fundingPips: {
    platform: 'FUNDINGPIPS',
    direction: 'SHORT',
    lots: 0.42,
    takeProfit: 4027,
    stopLoss: 4038,
    riskPct: 2,
  },
};

const intelligence = {
  horizonMs: 4 * 60 * 60 * 1_000,
  regime: 'BREAKOUT',
  decision: {
    state: 'COOLDOWN_SHORT',
    fpDirection: 'short',
    bybitDirection: 'LONG',
    autoEligible: true,
    probabilities: { down: 0.2, up: 0.7, neither: 0.1 },
    paths: {
      down: { probability: 0.2, label: 'BB SL / FP TP' },
      up: { probability: 0.7, label: 'BB TP / FP SL' },
      neither: { probability: 0.1, label: 'No barrier inside horizon' },
    },
    confidence: 0.72,
    edge: 0.5,
    source: 'COMBINED',
    stableSince: NOW - 120_000,
    nextSwitchAllowedAt: NOW + 480_000,
    generatedAt: NOW,
    decisionReferencePrice: 4034.5,
    outcomeAnchorPrice: 4035,
    sentiment: {
      market: { direction: 'LONG', score: 61 },
      whale: { direction: 'LONG', score: 72 },
      combined: { direction: 'LONG', score: 66 },
    },
    reasons: ['confirmed bounded evidence'],
  },
};

const values = {
  instrument: 'XAUUSD',
  entryPrice: 4035,
  fpDirection: 'short',
  slPct: 0.22,
  stage: 'p1',
  accountPreset: '10k',
  rrRatio: 2,
};

const memoryStorage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

test('complete trade snapshot persists and reloads without changing its ticket', () => {
  const storage = memoryStorage();
  const snapshot = createTradeSnapshot({
    position,
    values,
    intelligence,
    now: NOW,
  });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.entryPrice, 4035);
  assert.equal(snapshot.position.bybit.takeProfit, 4038);
  assert.equal(snapshot.decision.probabilities.up, 0.7);
  assert.match(snapshot.ticket, /BYBIT · LONG/);
  assert.match(snapshot.ticket, /HL DECISION · FP SHORT \/ BYBIT LONG/);

  persistTradeSnapshot(snapshot, storage);
  const reloaded = loadTradeSnapshot(storage, NOW + 60_000);
  assert.equal(reloaded.ticket, snapshot.ticket);
  assert.equal(reloaded.expired, false);
  assert.equal(Object.isFrozen(reloaded), true);
  assert.equal(storage.getItem(TRADE_SNAPSHOT_STORAGE_KEY).includes('4035'), true);
});

test('twenty live updates cannot mutate a frozen ticket while MARKET NOW advances', () => {
  const snapshot = createTradeSnapshot({
    position,
    values,
    intelligence,
    now: NOW,
  });
  const ticket = snapshot.ticket;

  let view;
  for (let index = 0; index < 20; index += 1) {
    view = resolveTradeView({
      livePosition: {
        ...position,
        bybit: {
          ...position.bybit,
          takeProfit: position.bybit.takeProfit + index,
        },
      },
      liveEntryPrice: 4035 + index,
      snapshot,
    });
  }

  assert.equal(view.position, snapshot.position);
  assert.equal(view.marketNowPrice, 4054);
  assert.equal(view.lockedEntryPrice, 4035);
  assert.equal(snapshot.ticket, ticket);
});

test('existing and expired snapshots require explicit unlock before replacement', () => {
  const storage = memoryStorage();
  const snapshot = createTradeSnapshot({
    position,
    values,
    intelligence,
    now: NOW,
  });
  persistTradeSnapshot(snapshot, storage);
  assert.throws(
    () => persistTradeSnapshot(snapshot, storage),
    /already exists/,
  );

  const expired = loadTradeSnapshot(storage, snapshot.expiresAt + 1);
  assert.equal(expired.expired, true);
  assert.throws(
    () => persistTradeSnapshot(snapshot, storage),
    /already exists/,
  );

  clearTradeSnapshot(storage);
  assert.equal(loadTradeSnapshot(storage, NOW), null);
  assert.doesNotThrow(() => persistTradeSnapshot(snapshot, storage));
});
