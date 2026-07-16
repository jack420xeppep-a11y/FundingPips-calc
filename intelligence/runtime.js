import { createHash } from 'node:crypto';

import { buildMarketOnlyForecast, createPredictionRecord } from './market-model.js';
import {
  buildPhaseAwareRecommendation,
  createRecommendationStabilizer,
} from './probability-engine.js';

const HORIZON_MS = 4 * 60 * 60 * 1_000;
const DEFAULT_JOBS = Object.freeze({
  observer: { lastRunAt: null, status: 'idle' },
  cohorts: { lastRunAt: null, status: 'idle' },
  retention: { lastRunAt: null, status: 'idle' },
});

const setupKey = (setup) => createHash('sha256').update(JSON.stringify({
  entryPrice: setup.entryPrice,
  slPct: setup.slPct,
  rrRatio: setup.rrRatio,
  stage: setup.stage,
  accountSize: setup.accountSize,
  riskPerTrade: setup.riskPerTrade,
  fundedRisk: setup.fundedRisk,
  profitSplit: setup.profitSplit,
  bybitStake: setup.bybitStake,
  intent: setup.intent,
})).digest('hex');

export function createGoldIntelligenceRuntime({
  database,
  marketStore,
  now = Date.now,
  jobState = DEFAULT_JOBS,
  maxStabilizers = 1_000,
} = {}) {
  if (
    !database?.getHealth ||
    !database?.listActiveWalletSignals ||
    !marketStore?.snapshot ||
    !marketStore?.subscribe
  ) {
    throw new Error('Gold intelligence runtime dependencies are incomplete.');
  }
  if (!Number.isInteger(maxStabilizers) || maxStabilizers < 1 || maxStabilizers > 10_000) {
    throw new Error('maxStabilizers is invalid.');
  }

  const listeners = new Set();
  const stabilizers = new Map();
  const unsubscribeMarket = marketStore.subscribe(() => {
    for (const listener of listeners) listener();
  });
  let closed = false;

  const getStabilizer = (key) => {
    let entry = stabilizers.get(key);
    if (entry) {
      entry.lastUsedAt = now();
      return entry.stabilizer;
    }
    if (stabilizers.size >= maxStabilizers) {
      const oldest = [...stabilizers.entries()].sort(
        (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
      )[0];
      if (oldest) stabilizers.delete(oldest[0]);
    }
    entry = {
      stabilizer: createRecommendationStabilizer({ now }),
      lastUsedAt: now(),
    };
    stabilizers.set(key, entry);
    return entry.stabilizer;
  };

  const recordShadowPredictions = (setup, result, snapshot) => {
    for (const fpDirection of ['long', 'short']) {
      const marketForecast = buildMarketOnlyForecast({
        snapshot,
        setup: { ...setup, fpDirection },
        horizonMs: HORIZON_MS,
      });
      if (!['ready', 'stale'].includes(marketForecast.status)) continue;
      const record = createPredictionRecord({
        forecast: marketForecast,
        setup: {
          ...setup,
          fpDirection,
          session: snapshot.market.session,
        },
        createdAt: snapshot.generatedAt,
        horizonMs: HORIZON_MS,
      });
      const candidate = result.candidates[fpDirection];
      record.probabilityUp = candidate.probabilities.up;
      record.probabilityDown = candidate.probabilities.down;
      record.probabilityNeither = candidate.probabilities.neither;
      record.combinedProbability = candidate.bybitTpProbability;
      record.walletProbability = result.cohortSize > 0
        ? candidate.walletBybitTpProbability
        : null;
      record.maturity = result.maturity;
      database.recordPrediction(record);
    }
  };

  return {
    getPublicSnapshot(setup) {
      if (closed) throw new Error('Gold intelligence runtime is closed.');
      const snapshot = marketStore.snapshot();
      const wallets = database.listActiveWalletSignals();
      const modelMetrics = database.getModelMetrics();
      const result = buildPhaseAwareRecommendation({
        snapshot,
        setup,
        wallets,
        modelMetrics,
        intent: setup.intent,
        horizonMs: HORIZON_MS,
      });
      recordShadowPredictions(setup, result, snapshot);
      const stability = getStabilizer(setupKey(setup)).update(result);

      return {
        version: 1,
        status: result.status,
        generatedAt: result.generatedAt,
        intent: result.intent,
        horizonMs: result.horizonMs,
        regime: result.regime,
        targetBand: result.targetBand,
        recommendation: {
          ...result.recommendation,
          stableDirection: stability.direction,
          stable: stability.stable,
          switchAllowedAt: stability.switchAllowedAt || null,
        },
        paths: result.paths,
        marketSignal: result.marketSignal,
        walletSignal: result.walletSignal,
        combinedSignal: result.combinedSignal,
        confidence: result.confidence,
        maturity: result.maturity,
        cohortSize: result.cohortSize,
        edge: result.edge,
        reasons: result.reasons,
        candidates: result.candidates,
        economics: result.economics,
        market: {
          symbol: 'xyz:GOLD',
          bybitSymbol: 'XAUUSD+',
          hyperliquidMid: snapshot.market?.hyperliquid?.mid ?? null,
          bybitMid: snapshot.market?.bybit?.mid ?? null,
          basisBps: snapshot.market?.basisBps ?? null,
          session: snapshot.market?.session ?? 'UNKNOWN',
          hyperliquidTimestamp: snapshot.market?.hyperliquid?.timestamp ?? null,
          bybitTimestamp: snapshot.market?.bybit?.timestamp ?? null,
          stale: snapshot.status !== 'live',
        },
      };
    },

    getPublicHealth() {
      const market = marketStore.snapshot();
      const databaseHealth = database.getHealth();
      const model = database.getModelMetrics();
      const status = market.status === 'live'
        ? 'live'
        : market.status === 'error'
          ? 'error'
          : market.status === 'stale'
            ? 'stale'
            : 'warming';
      return {
        version: 1,
        status,
        generatedAt: now(),
        market: {
          status: market.status,
          hyperliquidTimestamp: market.market?.hyperliquid?.timestamp ?? null,
          bybitTimestamp: market.market?.bybit?.timestamp ?? null,
          quoteCount: market.market?.bybit ? 1 : 0,
        },
        database: {
          schemaVersion: databaseHealth.schemaVersion,
          databaseBytes: databaseHealth.databaseBytes,
          walBytes: databaseHealth.walBytes,
          freelistPages: databaseHealth.freelistPages,
          lastRetentionAt: databaseHealth.lastRetentionAt,
          rows: databaseHealth.rows,
        },
        model: {
          resolvedCount: model.resolvedCount,
          brierScore: model.brierScore,
          hitRate: model.hitRate,
          calibrationBuckets: model.calibration.length,
        },
        jobs: {
          observer: { ...jobState.observer },
          cohorts: { ...jobState.cohorts },
          retention: { ...jobState.retention },
        },
      };
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('Listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      if (closed) return;
      closed = true;
      unsubscribeMarket();
      listeners.clear();
      stabilizers.clear();
    },
  };
}

