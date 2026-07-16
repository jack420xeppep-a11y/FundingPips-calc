import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GOLD_COIN,
  GOLD_SUBSCRIPTIONS,
  buildHyperliquidWebSocketUrl,
  createGoldMarketStore,
  createHyperliquidGoldUpstream,
  parseHyperliquidMessage,
} from './market-collector.js';
import {
  parseBybitRelaySnapshot,
  parseSseFrames,
} from './quote-relay-client.js';

const BUYER = '0x1111111111111111111111111111111111111111';
const SELLER = '0x2222222222222222222222222222222222222222';

const tradeMessage = (overrides = {}) => ({
  channel: 'trades',
  data: [{
    coin: GOLD_COIN,
    side: 'B',
    px: '4035.5',
    sz: '0.25',
    time: 1784194000000,
    hash: `0x${'a'.repeat(64)}`,
    tid: 123456789,
    users: [BUYER, SELLER],
    ...overrides,
  }],
});

test('gold collector declares only official xyz:GOLD subscriptions', () => {
  assert.equal(buildHyperliquidWebSocketUrl(), 'wss://api.hyperliquid.xyz/ws');
  assert.deepEqual(GOLD_SUBSCRIPTIONS, [
    { type: 'trades', coin: 'xyz:GOLD' },
    { type: 'bbo', coin: 'xyz:GOLD' },
    { type: 'l2Book', coin: 'xyz:GOLD', nSigFigs: 5 },
    { type: 'candle', coin: 'xyz:GOLD', interval: '1m' },
    { type: 'activeAssetCtx', coin: 'xyz:GOLD' },
  ]);
});

test('parser validates gold trades and preserves buyer/seller identity', () => {
  assert.deepEqual(parseHyperliquidMessage(tradeMessage()), {
    type: 'trades',
    trades: [{
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
    }],
  });

  assert.equal(parseHyperliquidMessage(tradeMessage({ coin: 'BTC' })), null);
  assert.equal(parseHyperliquidMessage(tradeMessage({ users: ['broken', SELLER] })), null);
  assert.equal(parseHyperliquidMessage(tradeMessage({ side: 'X' })), null);
  assert.equal(parseHyperliquidMessage(tradeMessage({ sz: '-1' })), null);
});

test('parser accepts BBO, bounded order book, active context, and candle updates', () => {
  assert.deepEqual(parseHyperliquidMessage({
    channel: 'bbo',
    data: {
      coin: GOLD_COIN,
      time: 1784194000100,
      bbo: [
        { px: '4035.5', sz: '1.25', n: 3 },
        { px: '4035.6', sz: '0.75', n: 2 },
      ],
    },
  }), {
    type: 'bbo',
    timestamp: 1784194000100,
    bid: 4035.5,
    ask: 4035.6,
    bidSize: 1.25,
    askSize: 0.75,
  });

  assert.deepEqual(parseHyperliquidMessage({
    channel: 'l2Book',
    data: {
      coin: GOLD_COIN,
      time: 1784194000200,
      levels: [
        [
          { px: '4035.5', sz: '3', n: 1 },
          { px: '4035.4', sz: '2', n: 1 },
        ],
        [
          { px: '4035.6', sz: '1', n: 1 },
          { px: '4035.7', sz: '4', n: 1 },
        ],
      ],
    },
  }), {
    type: 'book',
    timestamp: 1784194000200,
    bid: 4035.5,
    ask: 4035.6,
    bidDepth: 5,
    askDepth: 5,
    imbalance: 0,
  });

  assert.deepEqual(parseHyperliquidMessage({
    channel: 'activeAssetCtx',
    data: {
      coin: GOLD_COIN,
      ctx: {
        funding: '0.00000625',
        openInterest: '33299.3924',
        premium: '0.0004834391',
        oraclePx: '4033.6',
        markPx: '4035.6',
        midPx: '4035.55',
        dayNtlVlm: '41231081.32',
      },
    },
  }), {
    type: 'context',
    funding: 0.00000625,
    openInterest: 33299.3924,
    premium: 0.0004834391,
    oraclePrice: 4033.6,
    markPrice: 4035.6,
    midPrice: 4035.55,
    dayNotionalVolume: 41231081.32,
  });

  assert.deepEqual(parseHyperliquidMessage({
    channel: 'candle',
    data: {
      t: 1784193960000,
      T: 1784194019999,
      s: GOLD_COIN,
      i: '1m',
      o: '4034.0',
      c: '4035.0',
      h: '4036.0',
      l: '4033.5',
      v: '12.5',
      n: 42,
    },
  }), {
    type: 'candle',
    openTimestamp: 1784193960000,
    closeTimestamp: 1784194019999,
    interval: '1m',
    open: 4034,
    close: 4035,
    high: 4036,
    low: 4033.5,
    volume: 12.5,
    tradeCount: 42,
  });
});

test('market store deduplicates trades, bounds memory, and calculates rolling features', () => {
  let clock = 1784194000000;
  const emittedTrades = [];
  const store = createGoldMarketStore({
    now: () => clock,
    maxTrades: 3,
    maxPriceSamples: 4,
    staleAfterMs: 10_000,
    onTrades: (trades) => emittedTrades.push(...trades),
  });

  store.setHyperliquidStatus('connected');
  store.applyHyperliquid(parseHyperliquidMessage(tradeMessage()));
  store.applyHyperliquid(parseHyperliquidMessage(tradeMessage()));
  store.applyHyperliquid(parseHyperliquidMessage(tradeMessage({
    side: 'A',
    tid: 123456790,
    time: clock + 100,
    px: '4035.4',
    sz: '0.10',
  })));
  store.applyHyperliquid(parseHyperliquidMessage({
    channel: 'bbo',
    data: {
      coin: GOLD_COIN,
      time: clock + 200,
      bbo: [
        { px: '4035.4', sz: '3', n: 1 },
        { px: '4035.6', sz: '1', n: 1 },
      ],
    },
  }));
  store.applyHyperliquid(parseHyperliquidMessage({
    channel: 'activeAssetCtx',
    data: {
      coin: GOLD_COIN,
      ctx: {
        funding: '0.00000625',
        openInterest: '100',
        premium: '0.0004',
        oraclePx: '4034.0',
        markPx: '4035.5',
        midPx: '4035.5',
        dayNtlVlm: '1000000',
      },
    },
  }));
  store.applyBybitQuote({
    instrument: 'XAUUSD',
    bybitSymbol: 'XAUUSD+',
    bid: 4034.9,
    ask: 4035.1,
    mid: 4035,
    timestamp: clock + 250,
    stale: false,
  });

  const snapshot = store.snapshot();
  assert.equal(emittedTrades.length, 2);
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.market.hyperliquid.mid, 4035.5);
  assert.equal(snapshot.market.bybit.mid, 4035);
  assert.ok(snapshot.market.basisBps > 1.2 && snapshot.market.basisBps < 1.3);
  assert.equal(snapshot.features.bookImbalance, 0.5);
  assert.ok(snapshot.features.aggressiveFlow5m > 0);
  assert.equal(snapshot.diagnostics.recentTradeCount, 2);

  clock += 10_001;
  assert.equal(store.snapshot().status, 'stale');
});

test('quote relay client accepts only fresh XAUUSD+ snapshots and parses SSE frames', () => {
  const relay = parseBybitRelaySnapshot({
    version: 1,
    status: 'live',
    generatedAt: 1784194000000,
    staleAfterMs: 10_000,
    quotes: [
      {
        instrument: 'EURUSD',
        bybitSymbol: 'EURUSD+',
        bid: 1.1,
        ask: 1.2,
        mid: 1.15,
        timestamp: 1784194000000,
        stale: false,
      },
      {
        instrument: 'XAUUSD',
        bybitSymbol: 'XAUUSD+',
        bid: 4034.9,
        ask: 4035.1,
        mid: 4035,
        timestamp: 1784194000000,
        stale: false,
      },
    ],
  });
  assert.deepEqual(relay, {
    status: 'live',
    quote: {
      instrument: 'XAUUSD',
      bybitSymbol: 'XAUUSD+',
      bid: 4034.9,
      ask: 4035.1,
      mid: 4035,
      timestamp: 1784194000000,
      stale: false,
    },
  });

  const parsed = parseSseFrames(
    'event: snapshot\ndata: {"version":1}\n\n: keepalive\n\nevent: snapshot\ndata: {"version":2}\n\npartial',
  );
  assert.deepEqual(parsed.events, [
    { event: 'snapshot', data: '{"version":1}' },
    { event: 'snapshot', data: '{"version":2}' },
  ]);
  assert.equal(parsed.remainder, 'partial');
});

test('Hyperliquid upstream subscribes, heartbeats, closes failed sockets, and reconnects', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    emit(type, payload = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(payload);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }

  const statuses = [];
  const upstream = createHyperliquidGoldUpstream({
    WebSocketImpl: FakeWebSocket,
    onStatus: (status) => statuses.push(status.status),
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    heartbeatMs: 60_000,
  });

  upstream.start();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://api.hyperliquid.xyz/ws');
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit('open');
  assert.deepEqual(
    socket.sent.filter(({ method }) => method === 'subscribe').map(({ subscription }) => subscription),
    GOLD_SUBSCRIPTIONS,
  );

  socket.emit('error');
  assert.equal(socket.closed, true);
  assert.ok(statuses.includes('reconnecting'));
  upstream.stop();
});
