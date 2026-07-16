import { createHash } from 'node:crypto';

import { buildMarketOnlyForecast, createPredictionRecord } from './market-model.js';
import {
  buildPhaseAwareRecommendation,
  createRecommendationStabilizer,
} from './probability-engine.js';
import { createMarketSentimentAggregator } from './sentiment.js';
import { buildWhaleSentiment } from './whale-sentiment.js';

const HORIZON_MS = 4 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_JOBS = Object.freeze({
  observer: { lastRunAt: null, status: 'idle' },
  positions: { lastRunAt: null, status: 'idle' },
  cohorts: { lastRunAt: null, status: 'idle' },
  retention: { lastRunAt: null, status: 'idle' },
});

export const buildStrategyContextKey = (setup) => createHash('sha256').update(JSON.stringify({
  instrument: setup.instrument,
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
  broadcastIntervalMs = 0,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  marketSentimentAggregator = createMarketSentimentAggregator({ now }),
} = {}) {
  if (
    !database?.getHealth ||
    !database?.listActiveWalletSignals ||
    !database?.listWalletPositionSamples ||
    !database?.recordSentimentSnapshot ||
    !marketStore?.snapshot ||
    !marketStore?.subscribe ||
    !marketSentimentAggregator?.update
  ) {
    throw new Error('Gold intelligence runtime dependencies are incomplete.');
  }
  if (!Number.isInteger(maxStabilizers) || maxStabilizers < 1 || maxStabilizers > 10_000) {
    throw new Error('maxStabilizers is invalid.');
  }
  if (
    !Number.isInteger(broadcastIntervalMs) ||
    broadcastIntervalMs < 0 ||
    broadcastIntervalMs > 60_000 ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function'
  ) {
    throw new Error('Broadcast scheduling configuration is invalid.');
  }

  const listeners = new Set();
  const stabilizers = new Map();
  const shadowPredictionKeys = new Map();
  let broadcastTimer;
  const notifyListeners = () => {
    broadcastTimer = undefined;
    for (const listener of listeners) listener();
  };
  const unsubscribeMarket = marketStore.subscribe(() => {
    if (broadcastIntervalMs === 0) {
      notifyListeners();
      return;
    }
    if (broadcastTimer) return;
    broadcastTimer = setTimer(notifyListeners, broadcastIntervalMs);
    broadcastTimer?.unref?.();
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
    const key = `${Math.floor(snapshot.generatedAt / 60_000)}:${buildStrategyContextKey(setup)}`;
    if (shadowPredictionKeys.has(key)) return;
    let usable = false;
    for (const fpDirection of ['long', 'short']) {
      const decisionReferencePrice =
        snapshot.market?.priceContext?.decisionReferencePrice ??
        snapshot.market?.bybit?.mid ??
        setup.entryPrice;
      const marketForecast = buildMarketOnlyForecast({
        snapshot,
        setup: { ...setup, entryPrice: decisionReferencePrice, fpDirection },
        horizonMs: HORIZON_MS,
      });
      if (!['ready', 'stale'].includes(marketForecast.status)) continue;
      usable = true;
      const record = createPredictionRecord({
        forecast: marketForecast,
        setup: {
          ...setup,
          entryPrice: snapshot.market?.bybit?.mid ?? setup.entryPrice,
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
    if (!usable) return;
    shadowPredictionKeys.set(key, snapshot.generatedAt);
    while (shadowPredictionKeys.size > 10_000) {
      shadowPredictionKeys.delete(shadowPredictionKeys.keys().next().value);
    }
  };

  return {
    getPublicSnapshot(setup) {
      if (closed) throw new Error('Gold intelligence runtime is closed.');
      const snapshot = marketStore.snapshot();
      const marketSentimentUpdate = marketSentimentAggregator.update(snapshot);
      const marketSentiment = marketSentimentUpdate.sentiment;
      const wallets = database.listActiveWalletSignals();
      const modelMetrics = database.getModelMetrics();
      const decisionReferencePrice =
        snapshot.market?.priceContext?.decisionReferencePrice ??
        snapshot.market?.bybit?.mid ??
        setup.entryPrice;
      const result = buildPhaseAwareRecommendation({
        snapshot,
        setup: { ...setup, entryPrice: decisionReferencePrice },
        wallets,
        modelMetrics,
        intent: setup.intent,
        horizonMs: HORIZON_MS,
      });
      const positionSamples = database.listWalletPositionSamples({
        from: Math.max(1, snapshot.generatedAt - HOUR_MS),
        to: snapshot.generatedAt,
      });
      const whaleSentiment = buildWhaleSentiment({
        wallets,
        positionSamples,
        maturity: result.maturity,
        now: snapshot.generatedAt,
      });
      const walletWeight = whaleSentiment.status === 'ready'
        ? result.walletWeight
        : 0;
      const combinedScore = marketSentiment.score === null
        ? null
        : (
          whaleSentiment.score === null
            ? marketSentiment.score
            : (
              (marketSentiment.score * (1 - walletWeight)) +
              (whaleSentiment.score * walletWeight)
            )
        );
      const combinedDirection = combinedScore === null
        ? 'NEUTRAL'
        : combinedScore >= 8
          ? 'LONG'
          : combinedScore <= -8
            ? 'SHORT'
            : 'NEUTRAL';
      const combinedSentiment = {
        status: marketSentiment.status === 'ready'
          ? 'ready'
          : marketSentiment.status,
        direction: combinedDirection,
        score: combinedScore === null ? null : Math.round(combinedScore * 10) / 10,
        strength: combinedScore === null ? 0 : Math.round(Math.abs(combinedScore)),
        generatedAt: marketSentiment.generatedAt,
        stableForMs: marketSentiment.stableForMs,
        source: whaleSentiment.status === 'ready' ? 'MARKET_WHALE' : 'MARKET_ONLY',
      };
      if (
        marketSentimentUpdate.published &&
        marketSentiment.score !== null &&
        combinedSentiment.score !== null
      ) {
        database.recordSentimentSnapshot({
          timestamp: marketSentiment.generatedAt,
          marketScore: marketSentiment.score,
          whaleScore: whaleSentiment.score,
          combinedScore: combinedSentiment.score,
          direction: combinedSentiment.direction,
          qualifiedCount: whaleSentiment.qualifiedCount,
          freshnessMs: whaleSentiment.freshnessMs,
          maturity: result.maturity,
        });
      }
      recordShadowPredictions(setup, result, snapshot);
      const stability = getStabilizer(buildStrategyContextKey(setup)).update(result);

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
        sentiment: {
          market: marketSentiment,
          whale: whaleSentiment,
          combined: combinedSentiment,
        },
        walletState: {
          status: whaleSentiment.status,
          maturity: result.maturity,
          qualifiedCount: whaleSentiment.qualifiedCount,
          weight: walletWeight,
          freshnessMs: whaleSentiment.freshnessMs,
        },
        market: {
          symbol: 'xyz:GOLD',
          bybitSymbol: 'XAUUSD+',
          hyperliquidMid: snapshot.market?.hyperliquid?.mid ?? null,
          bybitMid: snapshot.market?.bybit?.mid ?? null,
          basisBps: snapshot.market?.basisBps ?? null,
          session: snapshot.market?.session ?? 'UNKNOWN',
          hyperliquidTimestamp: snapshot.market?.hyperliquid?.timestamp ?? null,
          bybitTimestamp: snapshot.market?.bybit?.timestamp ?? null,
          priceContext: {
            executionPrice: snapshot.market?.bybit?.mid ?? null,
            decisionReferencePrice,
            outcomeAnchorPrice: snapshot.market?.bybit?.mid ?? null,
            executionTimestamp: snapshot.market?.bybit?.timestamp ?? null,
            referenceTimestamp:
              snapshot.market?.priceContext?.referenceTimestamp ?? null,
            mode: snapshot.market?.priceContext?.mode ?? 'WARMING',
          },
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
          positions: { ...(jobState.positions ?? DEFAULT_JOBS.positions) },
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
      if (broadcastTimer) clearTimer(broadcastTimer);
      broadcastTimer = undefined;
      unsubscribeMarket();
      listeners.clear();
      stabilizers.clear();
      shadowPredictionKeys.clear();
    },
  };
}
