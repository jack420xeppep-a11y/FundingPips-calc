import { createHash } from 'node:crypto';

import { createDecisionStateMachine } from './decision-state.js';
import { buildMarketOnlyForecast, createPredictionRecord } from './market-model.js';
import { buildPhaseAwareRecommendation } from './probability-engine.js';
import { createMarketSentimentAggregator } from './sentiment.js';
import { buildWhaleSentiment } from './whale-sentiment.js';

const HORIZON_MS = 4 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const RAW_MODEL_INTERVAL_MS = 5_000;
const DEFAULT_JOBS = Object.freeze({
  observer: { lastRunAt: null, status: 'idle' },
  positions: { lastRunAt: null, status: 'idle' },
  requalification: { lastRunAt: null, status: 'idle' },
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

const emergencyEvidenceAligned = (snapshot, fpDirection) => {
  const move = fpDirection === 'short' ? 1 : -1;
  const momentum = Number(snapshot.features?.momentum15mBps ?? 0);
  const flow = Number(snapshot.features?.aggressiveFlow15m ?? 0);
  const oiChange = Number(
    snapshot.features?.openInterestChange15mPct ??
    snapshot.features?.openInterestChange5mPct ??
    0,
  );
  return (
    momentum * move >= 12 &&
    flow * move >= 0.15 &&
    oiChange >= 0.05
  );
};

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
  walletDataIntervalMs = 15_000,
} = {}) {
  if (
    !database?.getHealth ||
    !database?.listActiveWalletSignals ||
    !database?.listWalletPositionSamples ||
    !database?.recordSentimentSnapshot ||
    !database?.recordDecisionHistory ||
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
  if (
    !Number.isSafeInteger(walletDataIntervalMs) ||
    walletDataIntervalMs < 1_000 ||
    walletDataIntervalMs > 60_000
  ) {
    throw new Error('Wallet data cadence is invalid.');
  }

  const listeners = new Set();
  const contexts = new Map();
  const shadowPredictionKeys = new Map();
  let walletDataCache = null;
  const observability = {
    rawEvaluations: 0,
    sentimentPublications: 0,
    decisionPublications: 0,
    stableTransitions: 0,
    directionSwitches: 0,
    cooldownBlocks: 0,
    emergencyOverrides: 0,
    rawTargetDistribution: {
      under50: 0,
      from50To60: 0,
      from60To70: 0,
      atLeast70: 0,
    },
    stableStateDistribution: {},
    lastDecisionLagMs: null,
    lastMaturity: 0,
    lastWalletFreshnessMs: null,
    lastStableDirection: null,
  };
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

  const getContext = (key) => {
    let entry = contexts.get(key);
    if (entry) {
      entry.lastUsedAt = now();
      return entry;
    }
    if (contexts.size >= maxStabilizers) {
      const oldest = [...contexts.entries()].sort(
        (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
      )[0];
      if (oldest) contexts.delete(oldest[0]);
    }
    entry = {
      decisionMachine: createDecisionStateMachine(),
      rawResult: null,
      rawAt: 0,
      rawMarketStatus: null,
      lastUsedAt: now(),
    };
    contexts.set(key, entry);
    return entry;
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

  const getWalletData = (timestamp) => {
    if (
      walletDataCache &&
      timestamp >= walletDataCache.at &&
      timestamp - walletDataCache.at < walletDataIntervalMs
    ) {
      return walletDataCache;
    }
    walletDataCache = {
      at: timestamp,
      wallets: database.listActiveWalletSignals(),
      positionSamples: database.listWalletPositionSamples({
        from: Math.max(1, timestamp - HOUR_MS),
        to: timestamp,
      }),
      modelMetrics: database.getModelMetrics(),
    };
    return walletDataCache;
  };

  return {
    getPublicSnapshot(setup) {
      if (closed) throw new Error('Gold intelligence runtime is closed.');
      const snapshot = marketStore.snapshot();
      const marketSentimentUpdate = marketSentimentAggregator.update(snapshot);
      const marketSentiment = marketSentimentUpdate.sentiment;
      const walletData = getWalletData(snapshot.generatedAt);
      const { wallets, modelMetrics, positionSamples } = walletData;
      const strategyKey = buildStrategyContextKey(setup);
      const context = getContext(strategyKey);
      const decisionReferencePrice =
        snapshot.market?.priceContext?.decisionReferencePrice ??
        snapshot.market?.bybit?.mid ??
        setup.entryPrice;
      const modelDue =
        !context.rawResult ||
        snapshot.generatedAt - context.rawAt >= RAW_MODEL_INTERVAL_MS ||
        context.rawMarketStatus !== snapshot.status;
      if (modelDue) {
        context.rawResult = buildPhaseAwareRecommendation({
          snapshot,
          setup: { ...setup, entryPrice: decisionReferencePrice },
          wallets,
          modelMetrics,
          intent: setup.intent,
          horizonMs: HORIZON_MS,
        });
        context.rawAt = snapshot.generatedAt;
        context.rawMarketStatus = snapshot.status;
        observability.rawEvaluations += 1;
      }
      const result = context.rawResult;
      if (modelDue) {
        const target = Number(
          result.candidates?.[result.recommendation.fpDirection]?.bybitTpProbability,
        );
        const bucket = target < 0.5
          ? 'under50'
          : target < 0.6
            ? 'from50To60'
            : target < 0.7
              ? 'from60To70'
              : 'atLeast70';
        observability.rawTargetDistribution[bucket] += 1;
      }
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
        observability.sentimentPublications += 1;
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
      if (modelDue) recordShadowPredictions(setup, result, snapshot);
      const priceContext = {
        executionPrice: snapshot.market?.bybit?.mid ?? null,
        decisionReferencePrice,
        executionTimestamp: snapshot.market?.bybit?.timestamp ?? null,
        referenceTimestamp:
          snapshot.market?.priceContext?.referenceTimestamp ?? null,
        mode: snapshot.market?.priceContext?.mode ?? 'WARMING',
      };
      const decisionUpdate = context.decisionMachine.update({
        timestamp: snapshot.generatedAt,
        status: result.status === 'stale' || snapshot.status === 'stale'
          ? 'stale'
          : result.status === 'ready'
            ? 'ready'
            : 'warming',
        maturity: result.maturity,
        confidence: result.confidence,
        recommendation: result.recommendation.fpDirection,
        candidates: result.candidates,
        sentiment: {
          market: marketSentiment,
          whale: whaleSentiment,
          combined: combinedSentiment,
        },
        priceContext,
        reasons: [
          ...result.reasons,
          ...marketSentiment.reasons,
          ...whaleSentiment.reasons,
        ].slice(0, 8),
        walletReady: whaleSentiment.status === 'ready',
        emergencyAligned: emergencyEvidenceAligned(
          snapshot,
          result.recommendation.fpDirection,
        ),
      });
      const decision = decisionUpdate.decision;
      observability.lastMaturity = result.maturity;
      observability.lastWalletFreshnessMs = whaleSentiment.freshnessMs;
      observability.lastDecisionLagMs = Math.max(0, now() - decision.generatedAt);
      if (
        decision.state.startsWith('COOLDOWN_') &&
        decision.fpDirection &&
        result.recommendation.fpDirection !== decision.fpDirection
      ) {
        observability.cooldownBlocks += 1;
      }
      if (decisionUpdate.published) {
        observability.decisionPublications += 1;
        observability.stableStateDistribution[decision.state] =
          (observability.stableStateDistribution[decision.state] ?? 0) + 1;
        if (
          decision.autoEligible &&
          decision.fpDirection !== observability.lastStableDirection
        ) {
          observability.stableTransitions += 1;
          if (observability.lastStableDirection !== null) {
            observability.directionSwitches += 1;
            if (decision.transitionReason === 'EMERGENCY') {
              observability.emergencyOverrides += 1;
            }
          }
          observability.lastStableDirection = decision.fpDirection;
        }
      }
      if (
        decisionUpdate.published &&
        decision.autoEligible &&
        decision.outcomeAnchorPrice
      ) {
        database.recordDecisionHistory({
          strategyKey,
          emittedAt: decision.generatedAt,
          state: decision.state,
          fpDirection: decision.fpDirection,
          bybitDirection: decision.bybitDirection,
          probabilities: decision.probabilities,
          confidence: decision.confidence,
          source: decision.source,
          outcomeAnchorPrice: decision.outcomeAnchorPrice,
          expiresAt: decision.generatedAt + HORIZON_MS,
        });
      }
      const publicDirection = decision.fpDirection ?? result.recommendation.fpDirection;
      const publicBybitDirection = publicDirection === 'long' ? 'SHORT' : 'LONG';

      return {
        version: 1,
        status: result.status,
        generatedAt: result.generatedAt,
        intent: result.intent,
        horizonMs: result.horizonMs,
        regime: result.regime,
        targetBand: result.targetBand,
        recommendation: {
          fpDirection: publicDirection,
          bybitDirection: publicBybitDirection,
          autoEligible: decision.autoEligible,
          stableDirection: decision.autoEligible ? decision.fpDirection : null,
          stable: decision.autoEligible,
          switchAllowedAt: decision.nextSwitchAllowedAt,
        },
        paths: decision.paths ?? result.paths,
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
        decision,
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
            ...priceContext,
            outcomeAnchorPrice: decision.outcomeAnchorPrice,
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
        observability: {
          rawEvaluations: observability.rawEvaluations,
          sentimentPublications: observability.sentimentPublications,
          decisionPublications: observability.decisionPublications,
          stableTransitions: observability.stableTransitions,
          directionSwitches: observability.directionSwitches,
          cooldownBlocks: observability.cooldownBlocks,
          emergencyOverrides: observability.emergencyOverrides,
          rawTargetDistribution: { ...observability.rawTargetDistribution },
          stableStateDistribution: { ...observability.stableStateDistribution },
          lastDecisionLagMs: observability.lastDecisionLagMs,
          lastMaturity: observability.lastMaturity,
          lastWalletFreshnessMs: observability.lastWalletFreshnessMs,
        },
        jobs: {
          observer: { ...jobState.observer },
          positions: { ...(jobState.positions ?? DEFAULT_JOBS.positions) },
          requalification: {
            ...(jobState.requalification ?? DEFAULT_JOBS.requalification),
          },
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
      contexts.clear();
      shadowPredictionKeys.clear();
      walletDataCache = null;
    },
  };
}
