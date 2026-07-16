import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGoldIntelligenceContextKey,
  buildGoldIntelligenceQuery,
  createGoldIntelligenceFeed,
  parseGoldIntelligenceSnapshot,
} from './services/goldIntelligence.js';

const setup = {
  instrument: 'XAUUSD',
  entryPrice: 4035,
  slPct: 0.25,
  rrRatio: 2,
  stage: 'p1',
  accountSize: 10000,
  riskPerTrade: 2,
  fundedRisk: 1,
  profitSplit: 0.8,
  bybitStake: 25,
  intent: 'transfer-to-bybit',
};

const snapshot = {
  version: 1,
  status: 'ready',
  generatedAt: 1784194000000,
  intent: 'transfer-to-bybit',
  horizonMs: 14400000,
  regime: 'BREAKOUT',
  targetBand: '0.20-0.35%',
  recommendation: {
    fpDirection: 'long',
    bybitDirection: 'SHORT',
    autoEligible: true,
    stableDirection: 'long',
    stable: true,
    switchAllowedAt: 1784194120000,
  },
  paths: {
    down: { probability: 0.64, label: 'BB TP / FP SL' },
    up: { probability: 0.27, label: 'BB SL / FP TP' },
    neither: { probability: 0.09, label: 'No barrier inside horizon' },
  },
  marketSignal: 0.61,
  walletSignal: 0.73,
  combinedSignal: 0.68,
  confidence: 0.71,
  maturity: 0.18,
  cohortSize: 18,
  edge: 0.22,
  reasons: [
    'momentum, aggressive flow, and book are aligned',
    '14 verified traders currently hold SHORT; 4 hold LONG',
  ],
  candidates: {
    long: {
      probabilities: { up: 0.27, down: 0.64, neither: 0.09 },
      bybitTpProbability: 0.64,
      fundingPipsTpProbability: 0.27,
      marketBybitTpProbability: 0.61,
      walletBybitTpProbability: 0.73,
      expectedValueUsdEquivalent: 12,
    },
    short: {
      probabilities: { up: 0.3, down: 0.55, neither: 0.15 },
      bybitTpProbability: 0.3,
      fundingPipsTpProbability: 0.55,
      marketBybitTpProbability: 0.29,
      walletBybitTpProbability: 0.27,
      expectedValueUsdEquivalent: -8,
    },
  },
  economics: {
    phase: 'p1',
    includesFeesOrSpread: false,
    executionEnabled: false,
    valueType: 'challenge-progress-equivalent',
  },
  market: {
    symbol: 'xyz:GOLD',
    bybitSymbol: 'XAUUSD+',
    hyperliquidMid: 4035,
    bybitMid: 4035,
    basisBps: 0,
    session: 'LONDON',
    hyperliquidTimestamp: 1784194000000,
    bybitTimestamp: 1784194000000,
    stale: false,
  },
  sentiment: {
    market: {
      status: 'ready',
      direction: 'SHORT',
      score: -66,
      strength: 66,
      generatedAt: 1784194000000,
      stableForMs: 225000,
      regime: 'BREAKOUT',
      components: {
        trendMomentum: { weight: 26, raw: -0.8, value: -20.8 },
      },
      reasons: ['trend and momentum supports SHORT'],
    },
    whale: {
      status: 'ready',
      direction: 'SHORT',
      score: -72,
      strength: 72,
      qualifiedCount: 7,
      newPositions15m: { long: 1, short: 5 },
      netPositionChange15m: -1800000,
      netPositionChange1h: -2400000,
      entryCluster: { p25: 4028, p75: 4032 },
      conviction: 'HIGH',
      freshnessMs: 42000,
      maturity: 0.72,
      reasons: ['7 qualified whale positions are aggregated'],
    },
    combined: {
      status: 'ready',
      direction: 'SHORT',
      score: -66,
      strength: 66,
      generatedAt: 1784194000000,
      stableForMs: 225000,
      source: 'MARKET_WHALE',
    },
  },
  walletState: {
    status: 'ready',
    maturity: 0.72,
    qualifiedCount: 7,
    weight: 0.32,
    freshnessMs: 42000,
  },
  decision: {
    state: 'COOLDOWN_LONG',
    fpDirection: 'long',
    bybitDirection: 'SHORT',
    autoEligible: true,
    probabilities: { down: 0.64, up: 0.27, neither: 0.09 },
    paths: {
      down: { probability: 0.64, label: 'BB TP / FP SL' },
      up: { probability: 0.27, label: 'BB SL / FP TP' },
      neither: { probability: 0.09, label: 'No barrier inside horizon' },
    },
    confidence: 0.71,
    edge: 0.37,
    source: 'COMBINED',
    stableSince: 1784193880000,
    nextSwitchAllowedAt: 1784194480000,
    generatedAt: 1784194000000,
    decisionReferencePrice: 4034.5,
    outcomeAnchorPrice: 4035,
    sentiment: null,
    reasons: ['bounded stable evidence'],
    freshnessMs: 0,
  },
};

test('frontend validates the aggregate intelligence contract', () => {
  const parsed = parseGoldIntelligenceSnapshot(snapshot);
  assert.equal(parsed.recommendation.stableDirection, 'long');
  assert.equal(parsed.paths.down.probability, 0.64);
  assert.equal(parsed.cohortSize, 18);
  assert.equal(parsed.sentiment.market.score, -66);
  assert.equal(parsed.sentiment.whale.qualifiedCount, 7);
  assert.equal(parsed.sentiment.combined.source, 'MARKET_WHALE');
  assert.equal(parsed.decision.state, 'COOLDOWN_LONG');

  assert.equal(parseGoldIntelligenceSnapshot({
    ...snapshot,
    paths: {
      ...snapshot.paths,
      down: { ...snapshot.paths.down, probability: 2 },
    },
  }), null);
  assert.equal(parseGoldIntelligenceSnapshot({
    ...snapshot,
    wallets: [{ address: '0x1111111111111111111111111111111111111111' }],
  }), null);
  assert.equal(parseGoldIntelligenceSnapshot({
    ...snapshot,
    recommendation: { ...snapshot.recommendation, stableDirection: 'execute' },
  }), null);
  assert.equal(parseGoldIntelligenceSnapshot({
    ...snapshot,
    sentiment: {
      market: {
        ...snapshot.sentiment.market,
        score: -166,
      },
    },
  }), null);
  assert.equal(parseGoldIntelligenceSnapshot({
    ...snapshot,
    decision: {
      ...snapshot.decision,
      paths: {
        ...snapshot.decision.paths,
        down: {
          ...snapshot.decision.paths.down,
          label: 'BB SL / FP TP',
        },
      },
    },
  }), null);
});

test('query builder emits only the declared bounded setup fields', () => {
  const query = buildGoldIntelligenceQuery(setup);
  assert.equal(query.get('instrument'), 'XAUUSD');
  assert.equal(query.get('intent'), 'transfer-to-bybit');
  assert.equal(query.get('bybitStake'), '25');
  assert.deepEqual([...query.keys()].sort(), Object.keys(setup).sort());
});

test('frontend intelligence context does not reconnect when only live price changes', () => {
  const first = buildGoldIntelligenceContextKey({
    ...setup,
    entryPrice: 4029,
  });
  const second = buildGoldIntelligenceContextKey({
    ...setup,
    entryPrice: 4030,
  });
  assert.equal(first, second);
  assert.notEqual(first, buildGoldIntelligenceContextKey({
    ...setup,
    stage: 'p2',
  }));
});

test('EventSource feed reports lifecycle, snapshots, and closes cleanly', () => {
  class FakeEventSource {
    static instance;

    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      FakeEventSource.instance = this;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emit(type, payload = {}) {
      this.listeners.get(type)?.(payload);
    }

    close() {
      this.closed = true;
    }
  }

  const statuses = [];
  const received = [];
  const feed = createGoldIntelligenceFeed({
    setup,
    EventSourceImpl: FakeEventSource,
    onStatus: (state) => statuses.push(state.status),
    onSnapshot: (state) => received.push(state),
  });
  feed.start();
  assert.match(FakeEventSource.instance.url, /^\/api\/intelligence\/stream\?/);
  assert.match(FakeEventSource.instance.url, /instrument=XAUUSD/);
  FakeEventSource.instance.emit('open');
  FakeEventSource.instance.emit('snapshot', { data: JSON.stringify(snapshot) });
  FakeEventSource.instance.emit('error');
  feed.stop();

  assert.deepEqual(statuses, ['connecting', 'connected', 'reconnecting']);
  assert.equal(received[0].combinedSignal, 0.68);
  assert.equal(FakeEventSource.instance.closed, true);
});
