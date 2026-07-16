const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const integerFromEnv = (env, name, fallback, { minimum, maximum }) => {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
};

const absolutePath = (env, name, fallback) => {
  const value = env[name] ?? fallback;
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.includes('\0') ||
    value.length > 4_096
  ) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return value;
};

export function readServiceConfig(env = process.env) {
  const host = env.INTELLIGENCE_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new Error('INTELLIGENCE_HOST must be a loopback address.');
  }
  return Object.freeze({
    host,
    port: integerFromEnv(env, 'INTELLIGENCE_PORT', 8788, {
      minimum: 1_024,
      maximum: 65_535,
    }),
    databasePath: absolutePath(
      env,
      'INTELLIGENCE_DB_PATH',
      '/var/lib/calcpro-intelligence/hypergold.sqlite',
    ),
    seedPath: absolutePath(
      env,
      'INTELLIGENCE_SEED_PATH',
      '/var/lib/calcpro-intelligence/seed-wallets.json',
    ),
    quoteRelayUrl: env.BYBIT_RELAY_URL ?? 'http://127.0.0.1:8787/api/quotes',
    maxClients: integerFromEnv(env, 'INTELLIGENCE_MAX_CLIENTS', 100, {
      minimum: 1,
      maximum: 1_000,
    }),
    maxRequestsPerMinute: integerFromEnv(
      env,
      'INTELLIGENCE_MAX_REQUESTS_PER_MINUTE',
      600,
      {
        minimum: 1,
        maximum: 60_000,
      },
    ),
    observerIntervalMs: integerFromEnv(env, 'OBSERVER_INTERVAL_MS', HOUR_MS, {
      minimum: 15 * 60 * 1_000,
      maximum: DAY_MS,
    }),
    positionReconcileIntervalMs: integerFromEnv(
      env,
      'POSITION_RECONCILE_INTERVAL_MS',
      15 * 60 * 1_000,
      {
        minimum: 5 * 60 * 1_000,
        maximum: HOUR_MS,
      },
    ),
    cohortIntervalMs: integerFromEnv(env, 'COHORT_INTERVAL_MS', HOUR_MS, {
      minimum: 15 * 60 * 1_000,
      maximum: DAY_MS,
    }),
    retentionIntervalMs: integerFromEnv(env, 'RETENTION_INTERVAL_MS', DAY_MS, {
      minimum: HOUR_MS,
      maximum: 7 * DAY_MS,
    }),
    marketSampleIntervalMs: integerFromEnv(env, 'MARKET_SAMPLE_INTERVAL_MS', 60_000, {
      minimum: 5_000,
      maximum: 10 * 60 * 1_000,
    }),
    broadcastIntervalMs: integerFromEnv(env, 'BROADCAST_INTERVAL_MS', 1_000, {
      minimum: 250,
      maximum: 10_000,
    }),
    startJobs: env.INTELLIGENCE_START_JOBS !== 'false',
  });
}

export function createManagedJob({
  name,
  operation,
  state,
  now = Date.now,
  logger = () => {},
}) {
  if (
    typeof name !== 'string' ||
    typeof operation !== 'function' ||
    !state ||
    typeof state !== 'object'
  ) {
    throw new Error('Managed job configuration is invalid.');
  }
  let running = false;
  Object.assign(state, {
    status: state.status ?? 'idle',
    lastRunAt: state.lastRunAt ?? null,
    lastResult: state.lastResult ?? null,
  });

  return {
    async run() {
      if (running) return { skipped: true };
      running = true;
      state.status = 'running';
      state.startedAt = now();
      try {
        const result = await operation();
        state.status = 'ok';
        state.lastRunAt = now();
        state.lastResult = result;
        state.lastErrorType = null;
        logger({ event: `${name}_job_completed`, timestamp: state.lastRunAt });
        return result;
      } catch (error) {
        state.status = 'error';
        state.lastRunAt = now();
        state.lastErrorType = error?.name ?? 'Error';
        logger({
          event: `${name}_job_failed`,
          errorType: state.lastErrorType,
          timestamp: state.lastRunAt,
        });
        return { failed: true };
      } finally {
        running = false;
      }
    },
  };
}

export function createGoldIntelligenceService({
  config,
  database,
  runtime,
  httpServer,
  hyperliquidUpstream,
  quoteRelayClient,
  observer,
  positionReconciler,
  rotator,
  runRetention,
  jobState: injectedJobState,
  logger = () => {},
  now = Date.now,
} = {}) {
  if (
    !config ||
    !database?.close ||
    !runtime?.close ||
    !httpServer?.listen ||
    !httpServer?.close ||
    !hyperliquidUpstream?.start ||
    !hyperliquidUpstream?.stop ||
    !quoteRelayClient?.start ||
    !quoteRelayClient?.stop ||
    !observer?.runOnce ||
    !positionReconciler?.runOnce ||
    !rotator?.runOnce ||
    typeof runRetention !== 'function'
  ) {
    throw new Error('Gold intelligence service dependencies are incomplete.');
  }

  const jobState = injectedJobState ?? {
    observer: { status: 'idle', lastRunAt: null, lastResult: null },
    positions: { status: 'idle', lastRunAt: null, lastResult: null },
    cohorts: { status: 'idle', lastRunAt: null, lastResult: null },
    retention: { status: 'idle', lastRunAt: null, lastResult: null },
  };
  for (const name of ['observer', 'positions', 'cohorts', 'retention']) {
    jobState[name] ??= { status: 'idle', lastRunAt: null, lastResult: null };
  }
  const jobs = {
    observer: createManagedJob({
      name: 'observer',
      operation: () => observer.runOnce(),
      state: jobState.observer,
      now,
      logger,
    }),
    positions: createManagedJob({
      name: 'positions',
      operation: () => positionReconciler.runOnce(),
      state: jobState.positions,
      now,
      logger,
    }),
    cohorts: createManagedJob({
      name: 'cohorts',
      operation: () => rotator.runOnce(),
      state: jobState.cohorts,
      now,
      logger,
    }),
    retention: createManagedJob({
      name: 'retention',
      operation: () => runRetention(),
      state: jobState.retention,
      now,
      logger,
    }),
  };
  const timers = [];
  let started = false;
  let stopped = false;
  let address = null;

  const scheduleInterval = (job, intervalMs) => {
    const timer = setInterval(() => job.run(), intervalMs);
    timer.unref?.();
    timers.push(timer);
  };

  const scheduleOnce = (job, delayMs) => {
    const timer = setTimeout(() => job.run(), delayMs);
    timer.unref?.();
    timers.push(timer);
  };

  return {
    jobState,
    async start() {
      if (started) return address;
      if (stopped) throw new Error('Stopped service cannot be restarted.');
      address = await httpServer.listen();
      hyperliquidUpstream.start();
      quoteRelayClient.start();
      if (config.startJobs !== false) {
        scheduleOnce(jobs.retention, 1_000);
        scheduleOnce(jobs.observer, 10_000);
        scheduleOnce(jobs.positions, 20_000);
        scheduleOnce(jobs.cohorts, 30_000);
        scheduleInterval(jobs.observer, config.observerIntervalMs);
        scheduleInterval(jobs.positions, config.positionReconcileIntervalMs);
        scheduleInterval(jobs.cohorts, config.cohortIntervalMs);
        scheduleInterval(jobs.retention, config.retentionIntervalMs);
      }
      started = true;
      logger({ event: 'gold_intelligence_started', address, timestamp: now() });
      return address;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      timers.length = 0;
      quoteRelayClient.stop();
      hyperliquidUpstream.stop();
      await httpServer.close();
      runtime.close();
      database.close();
      logger({ event: 'gold_intelligence_stopped', timestamp: now() });
    },
  };
}
