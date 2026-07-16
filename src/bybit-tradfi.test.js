import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import {
  BYBIT_TRADFI_SYMBOLS,
  buildTradfiWebSocketUrl,
  decodeTradfiFrame,
  mergeTradfiTicker,
  parseTradfiTickerMessage,
} from './services/bybitTradfi.js';

test('maps every calculator instrument to the real Bybit TradFi symbol', () => {
  assert.deepEqual(BYBIT_TRADFI_SYMBOLS, {
    EURUSD: 'EURUSD+',
    GBPUSD: 'GBPUSD+',
    XAUUSD: 'XAUUSD+',
  });
});

test('parses Bybit TradFi snapshot and ignores unrelated or malformed tickers', () => {
  const message = JSON.stringify({
    topic: 'mt5.tickers.all',
    type: 'snapshot',
    data: [
      { s: 'EURUSD+', a: '1.14682', b: '1.14681', t: 1784185066759 },
      { s: 'GBPUSD+', a: '1.35348', b: '1.35346', t: 1784185066760 },
      { s: 'XAUUSD+', a: '4037.03', b: '4036.89', t: 1784185066761 },
      { s: 'BTCUSDT', a: '100000', b: '99999', t: 1784185066762 },
      { s: 'EURUSD+', a: 'not-a-price', t: 1784185066763 },
    ],
  });

  assert.deepEqual(parseTradfiTickerMessage(message), {
    type: 'snapshot',
    updates: [
      {
        instrument: 'EURUSD',
        bybitSymbol: 'EURUSD+',
        ask: 1.14682,
        bid: 1.14681,
        timestamp: 1784185066759,
      },
      {
        instrument: 'GBPUSD',
        bybitSymbol: 'GBPUSD+',
        ask: 1.35348,
        bid: 1.35346,
        timestamp: 1784185066760,
      },
      {
        instrument: 'XAUUSD',
        bybitSymbol: 'XAUUSD+',
        ask: 4037.03,
        bid: 4036.89,
        timestamp: 1784185066761,
      },
    ],
  });
});

test('merges partial deltas and calculates spread-free midpoint at instrument precision', () => {
  const previous = {
    instrument: 'EURUSD',
    bybitSymbol: 'EURUSD+',
    ask: 1.14682,
    bid: 1.1468,
    timestamp: 100,
  };

  assert.deepEqual(mergeTradfiTicker(previous, {
    instrument: 'EURUSD',
    bybitSymbol: 'EURUSD+',
    bid: 1.14681,
    timestamp: 200,
  }), {
    instrument: 'EURUSD',
    bybitSymbol: 'EURUSD+',
    ask: 1.14682,
    bid: 1.14681,
    price: 1.14682,
    timestamp: 200,
    source: 'Bybit TradFi',
  });

  assert.equal(mergeTradfiTicker(null, {
    instrument: 'XAUUSD',
    bybitSymbol: 'XAUUSD+',
    ask: 4037.03,
    bid: 4036.89,
    timestamp: 300,
  }).price, 4036.96);
});

test('decodes the gzip frames used by the Bybit TradFi websocket', async () => {
  const payload = JSON.stringify({ topic: 'mt5.tickers.all', type: 'delta', data: [] });
  const compressed = gzipSync(payload);
  const frame = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  );

  assert.equal(await decodeTradfiFrame(frame), payload);
  assert.equal(await decodeTradfiFrame(payload), payload);
});

test('rejects oversized frames and ticker floods from the external feed', async () => {
  const oversizedFrame = new Uint8Array(1_000_001).buffer;
  await assert.rejects(
    () => decodeTradfiFrame(oversizedFrame),
    /слишком большой live-кадр/,
  );

  assert.deepEqual(parseTradfiTickerMessage({
    topic: 'mt5.tickers.all',
    type: 'snapshot',
    data: new Array(5_001).fill({ s: 'EURUSD+', a: '1.1', b: '1.0', t: 1 }),
  }), { type: 'unknown', updates: [] });
});

test('builds the public Bybit TradFi websocket URL with a cache-busting timestamp', () => {
  assert.equal(
    buildTradfiWebSocketUrl(1784185066000),
    'wss://ws2.bybit.com/realtime_w?v=1&timestamp=1784185066000',
  );
});
