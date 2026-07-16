import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createIntelligenceHttpServer } from './api-server.js';
import { createCandidateObserver } from './candidate-observer.js';
import { createCohortRotator } from './cohorts.js';
import {
  createIntelligenceDatabase,
  loadSeedAddresses,
} from './database.js';
import { createHyperliquidInfoClient } from './hyperliquid-info.js';
import {
  createGoldMarketStore,
  createHyperliquidGoldUpstream,
} from './market-collector.js';
import { createBybitQuoteRelayClient } from './quote-relay-client.js';
import { createActivePositionReconciler } from './position-reconciler.js';
import { createGoldIntelligenceRuntime } from './runtime.js';
import {
  createGoldIntelligenceService,
  readServiceConfig,
} from './service.js';

const SERVICE_NAME = 'calcpro-gold-intelligence';

export function createStructuredLogger({
  write = (line) => process.stdout.write(line),
  now = Date.now,
} = {}) {
  if (typeof write !== 'function' || typeof now !== 'function') {
    throw new Error('Logger dependencies are invalid.');
  }
  return (entry = {}) => {
    const safe = {
      service: SERVICE_NAME,
      event: typeof entry.event === 'string'
        ? entry.event.slice(0, 120)
        : 'service_event',
      timestamp: Number.isSafeInteger(entry.timestamp) ? entry.timestamp : now(),
    };
    if (typeof entry.errorType === 'string') {
      safe.errorType = entry.errorType.slice(0, 80);
    }
    write(`${JSON.stringify(safe)}\n`);
  };
}

export function createMarketPersistence({
  database,
  sampleIntervalMs,
  logger = () => {},
} = {}) {
  if (
    !database?.recordTrades ||
    !database?.recordMarketSample ||
    !database?.resolvePredictionsWithPrice ||
    !Number.isInteger(sampleIntervalMs) ||
    sampleIntervalMs < 1_000
  ) {
    throw new Error('Market persistence dependencies are invalid.');
  }
  let lastSampleAt = 0;

  const captureFailure = (event, operation) => {
    try {
      return operation();
    } catch (error) {
      logger({
        event,
        errorType: error?.name ?? 'Error',
        timestamp: Date.now(),
      });
      return null;
    }
  };

  return {
    recordTrades(trades) {
      return captureFailure('gold_tape_storage_failed', () => database.recordTrades(trades));
    },
    recordSnapshot(snapshot) {
      if (
        snapshot?.status !== 'live' ||
        !Number.isSafeInteger(snapshot.generatedAt) ||
        snapshot.generatedAt - lastSampleAt < sampleIntervalMs
      ) {
        return null;
      }
      const hyperliquid = snapshot.market?.hyperliquid;
      const bybit = snapshot.market?.bybit;
      if (
        !Number.isFinite(hyperliquid?.mid) ||
        !Number.isFinite(bybit?.mid) ||
        !Number.isFinite(snapshot.market?.basisBps)
      ) {
        return null;
      }
      const result = captureFailure('gold_market_sample_storage_failed', () => (
        database.recordMarketSample({
          timestamp: snapshot.generatedAt,
          hyperliquidMid: hyperliquid.mid,
          bybitMid: bybit.mid,
          basisBps: snapshot.market.basisBps,
          markPrice: hyperliquid.mark,
          oraclePrice: hyperliquid.oracle,
          openInterest: hyperliquid.openInterest,
          funding: hyperliquid.funding,
          premium: hyperliquid.premium,
          session: snapshot.market.session,
          features: snapshot.features,
        })
      ));
      if (result !== null) lastSampleAt = snapshot.generatedAt;
      return result;
    },
    resolveQuote(quote) {
      if (
        quote?.instrument !== 'XAUUSD' ||
        quote.bybitSymbol !== 'XAUUSD+' ||
        !Number.isSafeInteger(quote.timestamp) ||
        !Number.isFinite(quote.mid)
      ) {
        return null;
      }
      return captureFailure('prediction_outcome_storage_failed', () => (
        database.resolvePredictionsWithPrice({
          timestamp: quote.timestamp,
          bybitMid: quote.mid,
        })
      ));
    },
  };
}

export function createProductionGoldIntelligence({
  env = process.env,
  logger = createStructuredLogger(),
} = {}) {
  const config = readServiceConfig(env);
  const database = createIntelligenceDatabase({ path: config.databasePath });
  if (existsSync(config.seedPath)) {
    const addresses = loadSeedAddresses(config.seedPath);
    const imported = database.importSeeds(addresses);
    logger({
      event: imported > 0 ? 'gold_seed_import_completed' : 'gold_seed_import_unchanged',
      timestamp: Date.now(),
    });
  }

  const persistence = createMarketPersistence({
    database,
    sampleIntervalMs: config.marketSampleIntervalMs,
    logger,
  });
  const marketStore = createGoldMarketStore({
    onTrades: (trades) => persistence.recordTrades(trades),
    onSnapshot: (snapshot) => persistence.recordSnapshot(snapshot),
  });
  const jobState = {
    observer: { status: 'idle', lastRunAt: null, lastResult: null },
    positions: { status: 'idle', lastRunAt: null, lastResult: null },
    requalification: { status: 'idle', lastRunAt: null, lastResult: null },
    cohorts: { status: 'idle', lastRunAt: null, lastResult: null },
    retention: { status: 'idle', lastRunAt: null, lastResult: null },
  };
  const runtime = createGoldIntelligenceRuntime({
    database,
    marketStore,
    jobState,
    broadcastIntervalMs: config.broadcastIntervalMs,
  });
  const httpServer = createIntelligenceHttpServer({
    host: config.host,
    port: config.port,
    maxClients: config.maxClients,
    maxRequestsPerMinute: config.maxRequestsPerMinute,
    getHealth: () => runtime.getPublicHealth(),
    getSnapshot: (setup) => runtime.getPublicSnapshot(setup),
    subscribe: (listener) => runtime.subscribe(listener),
  });
  const infoClient = createHyperliquidInfoClient();
  const observer = createCandidateObserver({
    database,
    infoClient,
    logger,
    candidateStatuses: ['DISCOVERED', 'OBSERVED', 'QUALIFIED', 'RETIRED'],
  });
  const positionReconciler = createActivePositionReconciler({
    database,
    infoClient,
    logger,
  });
  const requalifier = createCandidateObserver({
    database,
    infoClient,
    logger,
    candidateStatuses: ['ACTIVE_COHORT', 'PROBATION'],
    reviewIntervalMs: 24 * 60 * 60 * 1_000,
    maxCandidates: 100,
  });
  const rotator = createCohortRotator({
    database,
    logger,
  });
  const hyperliquidUpstream = createHyperliquidGoldUpstream({
    onEvent: (event) => marketStore.applyHyperliquid(event),
    onStatus: ({ status }) => marketStore.setHyperliquidStatus(status),
    onError: () => {
      marketStore.setHyperliquidStatus(
        'error',
        'Hyperliquid gold market feed is temporarily unavailable.',
      );
      logger({
        event: 'hyperliquid_gold_upstream_failed',
        errorType: 'UpstreamError',
        timestamp: Date.now(),
      });
    },
  });
  const quoteRelayClient = createBybitQuoteRelayClient({
    url: config.quoteRelayUrl,
    onQuote: (quote) => {
      marketStore.applyBybitQuote(quote);
      persistence.resolveQuote(quote);
    },
    onError: () => logger({
      event: 'bybit_quote_relay_failed',
      errorType: 'UpstreamError',
      timestamp: Date.now(),
    }),
  });

  return createGoldIntelligenceService({
    config,
    database,
    runtime,
    httpServer,
    hyperliquidUpstream,
    quoteRelayClient,
    observer,
    positionReconciler,
    requalifier,
    rotator,
    runRetention: () => database.runRetention(),
    jobState,
    logger,
  });
}

const isMainModule = process.argv[1] && (
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
);

if (isMainModule) {
  const logger = createStructuredLogger();
  let service;
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger({ event: `shutdown_${String(signal).toLowerCase()}`, timestamp: Date.now() });
    try {
      await service?.stop();
    } finally {
      process.exitCode = 0;
    }
  };

  try {
    service = createProductionGoldIntelligence({ logger });
    await service.start();
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger({
      event: 'gold_intelligence_startup_failed',
      errorType: error?.name ?? 'Error',
      timestamp: Date.now(),
    });
    await service?.stop().catch(() => {});
    process.exitCode = 1;
  }
}
