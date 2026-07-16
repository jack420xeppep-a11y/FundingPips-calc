import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQuoteRelayFeed,
  parseQuoteRelayMessage,
} from './services/quoteRelay.js';

test('frontend accepts the relay contract and rejects unrelated or malformed quotes', () => {
  const result = parseQuoteRelayMessage(JSON.stringify({
    version: 1,
    status: 'live',
    generatedAt: 30_000,
    staleAfterMs: 10_000,
    quotes: [
      {
        instrument: 'EURUSD',
        bybitSymbol: 'EURUSD+',
        bid: 1.1468,
        ask: 1.14682,
        mid: 1.14681,
        timestamp: 29_900,
        stale: false,
      },
      {
        instrument: 'BTCUSDT',
        bybitSymbol: 'BTCUSDT',
        bid: 100000,
        ask: 100001,
        mid: 100000.5,
        timestamp: 29_900,
        stale: false,
      },
      {
        instrument: 'GBPUSD',
        bybitSymbol: 'GBPUSD+',
        bid: -1,
        ask: 1.3,
        mid: 1.2,
        timestamp: 29_900,
        stale: false,
      },
    ],
  }));

  assert.deepEqual(result, {
    status: 'live',
    quotes: [{
      instrument: 'EURUSD',
      bybitSymbol: 'EURUSD+',
      bid: 1.1468,
      ask: 1.14682,
      price: 1.14681,
      timestamp: 29_900,
      stale: false,
      source: 'CalcPro Quote Relay',
    }],
  });
});

test('frontend EventSource feed reports connection lifecycle and closes cleanly', () => {
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
  const feed = createQuoteRelayFeed({
    EventSourceImpl: FakeEventSource,
    onStatus: (status) => statuses.push(status.status),
    onQuotes: (quotes) => received.push(...quotes),
  });

  feed.start();
  assert.equal(FakeEventSource.instance.url, '/api/quotes');
  FakeEventSource.instance.emit('open');
  FakeEventSource.instance.emit('snapshot', {
    data: JSON.stringify({
      version: 1,
      status: 'stale',
      generatedAt: 40_000,
      staleAfterMs: 10_000,
      quotes: [{
        instrument: 'XAUUSD',
        bybitSymbol: 'XAUUSD+',
        bid: 4034.9,
        ask: 4035.1,
        mid: 4035,
        timestamp: 20_000,
        stale: true,
      }],
    }),
  });
  FakeEventSource.instance.emit('error');
  feed.stop();

  assert.deepEqual(statuses, ['connecting', 'connected', 'stale', 'reconnecting']);
  assert.equal(received[0].price, 4035);
  assert.equal(received[0].stale, true);
  assert.equal(FakeEventSource.instance.closed, true);
});
