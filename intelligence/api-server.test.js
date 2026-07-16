import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntelligenceHttpServer,
  parseIntelligenceSetup,
} from './api-server.js';

const validQuery = new URLSearchParams({
  instrument: 'XAUUSD',
  entryPrice: '4035',
  slPct: '0.25',
  rrRatio: '2',
  stage: 'p1',
  accountSize: '10000',
  riskPerTrade: '2',
  fundedRisk: '1',
  profitSplit: '0.8',
  bybitStake: '25',
  intent: 'transfer-to-bybit',
});

test('setup parser accepts only bounded gold calculator inputs', () => {
  assert.deepEqual(parseIntelligenceSetup(validQuery), {
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
  });

  const forex = new URLSearchParams(validQuery);
  forex.set('instrument', 'EURUSD');
  assert.throws(() => parseIntelligenceSetup(forex), /gold-only/);
  const huge = new URLSearchParams(validQuery);
  huge.set('accountSize', '999999999');
  assert.throws(() => parseIntelligenceSetup(huge), /accountSize/);
  const unknown = new URLSearchParams(validQuery);
  unknown.set('intent', 'execute-orders');
  assert.throws(() => parseIntelligenceSetup(unknown), /intent/);
});

test('HTTP server exposes aggregate health and prediction without private data', async (t) => {
  const snapshots = [];
  const server = createIntelligenceHttpServer({
    host: '127.0.0.1',
    port: 0,
    getHealth: () => ({
      version: 1,
      status: 'live',
      market: { status: 'live' },
      database: { databaseBytes: 4096, rows: { wallets: 20 } },
    }),
    getSnapshot: (setup) => {
      snapshots.push(setup);
      return {
        version: 1,
        status: 'ready',
        recommendation: {
          fpDirection: 'long',
          bybitDirection: 'SHORT',
          autoEligible: true,
        },
        paths: {
          down: { probability: 0.64, label: 'BB TP / FP SL' },
          up: { probability: 0.27, label: 'BB SL / FP TP' },
          neither: { probability: 0.09, label: 'No barrier inside horizon' },
        },
        confidence: 0.71,
        maturity: 0.18,
        cohortSize: 18,
        reasons: ['aggregate reason'],
      };
    },
    subscribe: () => () => {},
  });
  const address = await server.listen();
  t.after(() => server.close());

  const health = await fetch(`${address}/api/intelligence/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await health.json()).data.database.rows.wallets, 20);

  const response = await fetch(
    `${address}/api/intelligence/snapshot?${validQuery}`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.recommendation.fpDirection, 'long');
  assert.equal(snapshots[0].instrument, 'XAUUSD');
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /0x[0-9a-f]{40}/i);
  assert.doesNotMatch(serialized, /seed|walletWeight|privateKey|filesystem/i);

  const rejected = await fetch(`${address}/api/intelligence/snapshot`, {
    method: 'POST',
  });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');

  const invalid = await fetch(
    `${address}/api/intelligence/snapshot?instrument=XAUUSD`,
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_SETUP');
});

test('SSE stream sends bounded snapshots and unsubscribes on close', async (t) => {
  let listener;
  let unsubscribed = false;
  const server = createIntelligenceHttpServer({
    host: '127.0.0.1',
    port: 0,
    heartbeatMs: 60_000,
    getHealth: () => ({ version: 1, status: 'live' }),
    getSnapshot: () => ({
      version: 1,
      status: 'ready',
      recommendation: {
        fpDirection: 'long',
        bybitDirection: 'SHORT',
        autoEligible: true,
      },
    }),
    subscribe: (next) => {
      listener = next;
      return () => {
        unsubscribed = true;
      };
    },
  });
  const address = await server.listen();
  t.after(() => server.close());
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(
    `${address}/api/intelligence/stream?${validQuery}`,
    { signal: abort.signal },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: snapshot/);
  assert.match(initial, /"fpDirection":"long"/);

  listener();
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /event: snapshot/);
  abort.abort();
  await reader.cancel().catch(() => {});
  for (let attempt = 0; attempt < 50 && !unsubscribed; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(unsubscribed, true);
});

test('HTTP server enforces loopback and client bounds', () => {
  assert.throws(() => createIntelligenceHttpServer({
    host: '0.0.0.0',
    getHealth: () => ({}),
    getSnapshot: () => ({}),
    subscribe: () => () => {},
  }), /loopback/);
  assert.throws(() => createIntelligenceHttpServer({
    maxClients: 0,
    getHealth: () => ({}),
    getSnapshot: () => ({}),
    subscribe: () => () => {},
  }), /maxClients/);
});
