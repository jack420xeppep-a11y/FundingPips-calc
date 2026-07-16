import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoldIntelligenceService,
  createManagedJob,
  readServiceConfig,
} from './service.js';

test('service config is loopback-only and keeps conservative job cadence', () => {
  const config = readServiceConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8788);
  assert.equal(config.databasePath, '/var/lib/calcpro-intelligence/hypergold.sqlite');
  assert.equal(config.seedPath, '/var/lib/calcpro-intelligence/seed-wallets.json');
  assert.equal(config.observerIntervalMs, 60 * 60 * 1000);
  assert.equal(config.cohortIntervalMs, 60 * 60 * 1000);
  assert.equal(config.retentionIntervalMs, 24 * 60 * 60 * 1000);
  assert.equal(config.marketSampleIntervalMs, 60 * 1000);
  assert.equal(config.positionReconcileIntervalMs, 15 * 60 * 1000);
  assert.equal(config.broadcastIntervalMs, 1000);
  assert.equal(config.maxRequestsPerMinute, 600);

  assert.throws(() => readServiceConfig({ INTELLIGENCE_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => readServiceConfig({ INTELLIGENCE_PORT: '80' }), /INTELLIGENCE_PORT/);
  assert.throws(
    () => readServiceConfig({ INTELLIGENCE_DB_PATH: 'relative.sqlite' }),
    /absolute/,
  );
  assert.throws(
    () => readServiceConfig({ OBSERVER_INTERVAL_MS: '1000' }),
    /OBSERVER_INTERVAL_MS/,
  );
});

test('managed jobs prevent overlap and expose aggregate state', async () => {
  let release;
  let calls = 0;
  const state = {};
  const job = createManagedJob({
    name: 'observer',
    state,
    now: () => 1000 + calls,
    logger: () => {},
    operation: async () => {
      calls += 1;
      await new Promise((resolve) => {
        release = resolve;
      });
      return { reviewed: 2 };
    },
  });

  const first = job.run();
  assert.deepEqual(await job.run(), { skipped: true });
  release();
  assert.deepEqual(await first, { reviewed: 2 });
  assert.equal(calls, 1);
  assert.equal(state.status, 'ok');
  assert.equal(state.lastRunAt, 1001);
  assert.deepEqual(state.lastResult, { reviewed: 2 });
});

test('service starts and stops every isolated dependency exactly once', async () => {
  const calls = [];
  const makeStartStop = (name) => ({
    start() {
      calls.push(`${name}:start`);
    },
    stop() {
      calls.push(`${name}:stop`);
    },
  });
  const httpServer = {
    async listen() {
      calls.push('http:listen');
      return 'http://127.0.0.1:8788';
    },
    async close() {
      calls.push('http:close');
    },
  };
  const runtime = {
    close() {
      calls.push('runtime:close');
    },
  };
  const database = {
    close() {
      calls.push('database:close');
    },
  };
  const service = createGoldIntelligenceService({
    config: { startJobs: false },
    database,
    runtime,
    httpServer,
    hyperliquidUpstream: makeStartStop('hyperliquid'),
    quoteRelayClient: makeStartStop('quote'),
    observer: { runOnce: async () => ({ reviewed: 0 }) },
    positionReconciler: { runOnce: async () => ({ reviewed: 0 }) },
    rotator: { runOnce: async () => ({ reviewed: 0 }) },
    runRetention: () => ({ deleted: {} }),
    logger: () => {},
  });

  assert.equal(await service.start(), 'http://127.0.0.1:8788');
  assert.equal(await service.start(), 'http://127.0.0.1:8788');
  await service.stop();
  await service.stop();
  assert.deepEqual(calls, [
    'http:listen',
    'hyperliquid:start',
    'quote:start',
    'quote:stop',
    'hyperliquid:stop',
    'http:close',
    'runtime:close',
    'database:close',
  ]);
});
