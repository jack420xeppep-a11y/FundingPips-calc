import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHyperliquidInfoClient,
  createWeightedRateLimiter,
  normalizeGoldFill,
} from './hyperliquid-info.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

const fill = (overrides = {}) => ({
  coin: 'xyz:GOLD',
  px: '4035.5',
  sz: '0.25',
  side: 'B',
  time: 1784194000000,
  startPosition: '0',
  dir: 'Open Long',
  closedPnl: '0',
  hash: `0x${'a'.repeat(64)}`,
  oid: 496594238924,
  crossed: true,
  fee: '0.12',
  tid: 266729800089361,
  ...overrides,
});

test('gold fill normalization preserves position reconstruction fields', () => {
  assert.deepEqual(normalizeGoldFill(ADDRESS, fill()), {
    address: ADDRESS,
    coin: 'xyz:GOLD',
    price: 4035.5,
    size: 0.25,
    side: 'B',
    timestamp: 1784194000000,
    startPosition: 0,
    direction: 'Open Long',
    closedPnl: 0,
    hash: `0x${'a'.repeat(64)}`,
    oid: 496594238924,
    crossed: true,
    fee: 0.12,
    tid: 266729800089361,
  });
  assert.equal(normalizeGoldFill(ADDRESS, fill({ coin: 'BTC' })), null);
  assert.equal(normalizeGoldFill(ADDRESS, fill({ startPosition: 'broken' })), null);
  assert.equal(normalizeGoldFill('broken', fill()), null);
});

test('info client paginates complete fills, filters xyz:GOLD, and deduplicates', async () => {
  const requests = [];
  const pages = [
    [
      fill({ time: 1000, tid: 1 }),
      fill({ time: 2000, tid: 2 }),
      fill({ coin: 'BTC', time: 2000, tid: 3 }),
    ],
    [
      fill({ time: 2000, tid: 2 }),
      fill({ time: 3000, tid: 4, side: 'A', startPosition: '1' }),
    ],
    [],
  ];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(pages.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createHyperliquidInfoClient({
    fetchImpl,
    fillsPageLimit: 2,
    limiter: { acquire: async () => {} },
  });

  const result = await client.fetchUserGoldFills(ADDRESS, {
    startTime: 1000,
    endTime: 4000,
  });

  assert.deepEqual(result.map(({ timestamp, tid }) => ({ timestamp, tid })), [
    { timestamp: 1000, tid: 1 },
    { timestamp: 2000, tid: 2 },
    { timestamp: 3000, tid: 4 },
  ]);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], {
    type: 'userFillsByTime',
    user: ADDRESS,
    startTime: 1000,
    endTime: 4000,
    aggregateByTime: false,
  });
  assert.equal(requests[1].startTime, 2001);
  assert.equal(requests[2].startTime, 3001);
});

test('info client requests HIP-3 state with dex xyz and returns only gold position', async () => {
  let body;
  const client = createHyperliquidInfoClient({
    limiter: { acquire: async () => {} },
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({
        assetPositions: [
          { position: { coin: 'xyz:TSLA', szi: '1' } },
          {
            type: 'oneWay',
            position: {
              coin: 'xyz:GOLD',
              szi: '-2.5',
              entryPx: '4039.5',
              positionValue: '10098.75',
              unrealizedPnl: '12.5',
            },
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await client.fetchGoldPosition(ADDRESS), {
    side: 'SHORT',
    size: 2.5,
    signedSize: -2.5,
    entryPrice: 4039.5,
    positionValue: 10098.75,
    unrealizedPnl: 12.5,
  });
  assert.deepEqual(body, {
    type: 'clearinghouseState',
    user: ADDRESS,
    dex: 'xyz',
  });
});

test('weighted limiter waits instead of exceeding its configured budget', async () => {
  let clock = 0;
  const waits = [];
  const limiter = createWeightedRateLimiter({
    capacity: 40,
    refillPerMinute: 40,
    now: () => clock,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });

  await limiter.acquire(20);
  await limiter.acquire(20);
  await limiter.acquire(20);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 29_999);
  assert.ok(waits[0] <= 30_001);
});

test('info client rejects oversized or non-JSON upstream responses', async () => {
  const oversizedClient = createHyperliquidInfoClient({
    maxResponseBytes: 64,
    limiter: { acquire: async () => {} },
    fetchImpl: async () => new Response(JSON.stringify({ data: 'x'.repeat(100) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    () => oversizedClient.fetchGoldPosition(ADDRESS),
    /response exceeded/,
  );

  const invalidClient = createHyperliquidInfoClient({
    limiter: { acquire: async () => {} },
    fetchImpl: async () => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    () => invalidClient.fetchGoldPosition(ADDRESS),
    /invalid JSON/,
  );
});

