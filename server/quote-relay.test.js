import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import {
  BYBIT_TRADFI_SYMBOLS,
  buildTradfiWebSocketUrl,
  createBybitTradfiUpstream,
  createQuoteRelayHttpServer,
  createQuoteStore,
  decodeBybitFrame,
  mergeBybitQuote,
  parseBybitMessage,
} from './quote-relay.js';

test('upstream closes a failed socket before scheduling reconnect', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static instance;

    constructor() {
      this.listeners = new Map();
      this.readyState = 0;
      this.closed = false;
      FakeWebSocket.instance = this;
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emit(type) {
      this.listeners.get(type)?.({});
    }

    close() {
      this.closed = true;
      this.readyState = 3;
    }
  }

  const upstream = createBybitTradfiUpstream({ WebSocketImpl: FakeWebSocket });
  upstream.start();
  FakeWebSocket.instance.emit('error');
  assert.equal(FakeWebSocket.instance.closed, true);
  upstream.stop();
});

test('upstream boundary rejects oversized frames, ticker floods, and crossed quotes', async () => {
  assert.equal(
    buildTradfiWebSocketUrl(1784185066000),
    'wss://ws2.bybit.com/realtime_w?v=1&timestamp=1784185066000',
  );
  await assert.rejects(
    () => decodeBybitFrame(Buffer.alloc(1_000_001)),
    /exceeds the relay limit/,
  );
  assert.deepEqual(parseBybitMessage({
    topic: 'mt5.tickers.all',
    type: 'snapshot',
    data: new Array(5_001).fill({ s: 'EURUSD+', a: '1.1', b: '1.0', t: 1 }),
  }), { type: 'unknown', updates: [] });
  assert.equal(mergeBybitQuote(null, {
    instrument: 'EURUSD',
    bybitSymbol: 'EURUSD+',
    ask: 1,
    bid: 1.1,
    sourceTimestamp: 1,
  }, 1), null);
});

test('server accepts only the three calculator symbols from the Bybit TradFi feed', async () => {
  assert.deepEqual(BYBIT_TRADFI_SYMBOLS, {
    EURUSD: 'EURUSD+',
    GBPUSD: 'GBPUSD+',
    XAUUSD: 'XAUUSD+',
  });

  const payload = JSON.stringify({
    topic: 'mt5.tickers.all',
    type: 'delta',
    data: [
      { s: 'EURUSD+', a: '1.14682', b: '1.14680', t: 1784185066759 },
      { s: 'GBPUSD+', a: 'broken', b: null, t: 1784185066760 },
      { s: 'BTCUSDT', a: '100001', b: '100000', t: 1784185066761 },
      { s: 'XAUUSD+', a: '4035.1', b: '4034.9' },
    ],
  });
  const compressed = gzipSync(payload);

  assert.equal(await decodeBybitFrame(compressed), payload);
  assert.deepEqual(parseBybitMessage(payload), {
    type: 'delta',
    updates: [{
      instrument: 'EURUSD',
      bybitSymbol: 'EURUSD+',
      ask: 1.14682,
      bid: 1.1468,
      sourceTimestamp: 1784185066759,
    }],
  });
});

test('quote store merges partial deltas and exposes the versioned relay contract with staleness', () => {
  let clock = 10_000;
  const store = createQuoteStore({ now: () => clock, staleAfterMs: 5_000 });

  const first = mergeBybitQuote(null, {
    instrument: 'XAUUSD',
    bybitSymbol: 'XAUUSD+',
    ask: 4035.1,
    bid: 4034.9,
    sourceTimestamp: 20_700,
  }, 9_900);
  const second = mergeBybitQuote(first, {
    instrument: 'XAUUSD',
    bybitSymbol: 'XAUUSD+',
    bid: 4035,
    sourceTimestamp: 20_800,
  }, 10_000);

  store.setStatus('connected');
  store.applyQuotes([second]);

  assert.deepEqual(store.snapshot(), {
    version: 1,
    status: 'live',
    generatedAt: 10_000,
    staleAfterMs: 5_000,
    quotes: [{
      instrument: 'XAUUSD',
      bybitSymbol: 'XAUUSD+',
      bid: 4035,
      ask: 4035.1,
      mid: 4035.05,
      timestamp: 10_000,
      stale: false,
    }],
  });

  clock = 15_001;
  assert.equal(store.snapshot().status, 'stale');
  assert.equal(store.snapshot().quotes[0].stale, true);
});

test('HTTP relay serves health JSON and streams same-origin SSE snapshots', async (t) => {
  let clock = 20_000;
  const store = createQuoteStore({ now: () => clock, staleAfterMs: 5_000 });
  store.setStatus('connected');
  store.applyQuotes([mergeBybitQuote(null, {
    instrument: 'EURUSD',
    bybitSymbol: 'EURUSD+',
    ask: 1.14682,
    bid: 1.1468,
    sourceTimestamp: 30_800,
  }, 20_000)]);

  const relay = createQuoteRelayHttpServer({
    store,
    host: '127.0.0.1',
    port: 0,
    heartbeatMs: 60_000,
  });
  const address = await relay.listen();
  t.after(() => relay.close());

  const health = await fetch(`${address}/api/quote-health`);
  assert.equal(health.status, 503);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), {
    data: {
      status: 'live',
      clientCount: 0,
      quoteCount: 1,
      generatedAt: 20_000,
    },
  });

  store.applyQuotes([
    mergeBybitQuote(null, {
      instrument: 'GBPUSD',
      bybitSymbol: 'GBPUSD+',
      ask: 1.3535,
      bid: 1.3534,
      sourceTimestamp: 30_900,
    }, 20_000),
    mergeBybitQuote(null, {
      instrument: 'XAUUSD',
      bybitSymbol: 'XAUUSD+',
      ask: 4035.1,
      bid: 4034.9,
      sourceTimestamp: 30_900,
    }, 20_000),
  ]);
  const readyHealth = await fetch(`${address}/api/quote-health`);
  assert.equal(readyHealth.status, 200);
  assert.equal((await readyHealth.json()).data.quoteCount, 3);

  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${address}/api/quotes`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);

  const reader = response.body.getReader();
  const firstEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstEvent, /event: snapshot/);
  assert.match(firstEvent, /"instrument":"EURUSD"/);

  clock = 20_100;
  store.applyQuotes([mergeBybitQuote(null, {
    instrument: 'GBPUSD',
    bybitSymbol: 'GBPUSD+',
    ask: 1.3536,
    bid: 1.3535,
    sourceTimestamp: 31_000,
  }, 20_100)]);
  const secondEvent = new TextDecoder().decode((await reader.read()).value);
  assert.match(secondEvent, /"instrument":"GBPUSD"/);

  const rejected = await fetch(`${address}/api/quotes`, { method: 'POST' });
  assert.equal(rejected.status, 405);
});
