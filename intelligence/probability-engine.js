import { buildMarketOnlyForecast } from './market-model.js';

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_HORIZON_MS = 4 * HOUR_MS;

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number(value)));

const round = (value, decimals = 8) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const targetBandForPct = (percentage) => {
  const value = Number(percentage);
  if (value < 0.2) return '0-0.20%';
  if (value < 0.35) return '0.20-0.35%';
  if (value < 0.6) return '0.35-0.60%';
  if (value < 1) return '0.60-1.00%';
  return '1.00%+';
};

const targetCohort = (targetBand) => `TARGET_${String(targetBand)
  .toUpperCase()
  .replaceAll('%', '')
  .replaceAll('.', '_')
  .replaceAll('-', '_')
  .replaceAll(/[^A-Z0-9_]/g, '_')
  .replaceAll(/_+/g, '_')
  .replace(/^_|_$/g, '')}`;

const membershipSet = (wallet) => new Set(
  (wallet.memberships ?? []).map(({ cohort }) => cohort),
);

export function buildWalletSignal({
  wallets,
  session,
  regime,
  targetBand,
  now = Date.now(),
}) {
  if (!Array.isArray(wallets) || !Number.isSafeInteger(now) || now <= 0) {
    throw new Error('Wallet signal inputs are invalid.');
  }
  const active = wallets.filter((wallet) => (
    wallet?.status === 'ACTIVE_COHORT' &&
    ['LONG', 'SHORT'].includes(wallet.positionSide) &&
    Number.isFinite(wallet.positionUpdatedAt) &&
    now - wallet.positionUpdatedAt <= 24 * HOUR_MS &&
    wallet.score?.overallScore > 0
  ));
  if (active.length === 0) {
    return {
      status: 'warming',
      probabilityUp: 0.5,
      probabilityDown: 0.5,
      confidence: 0,
      maturity: 0,
      cohortSize: 0,
      reasons: ['verified wallet cohort is still warming'],
      diagnostics: { clusterCount: 0, totalEpisodeCount: 0 },
    };
  }

  const clusters = new Map();
  for (const wallet of active) {
    const entryBucket = Math.round(Number(wallet.positionEntryPrice ?? 0) * 10) / 10;
    const timeBucket = Math.floor(wallet.positionUpdatedAt / (5 * 60 * 1_000));
    const key = `${wallet.positionSide}:${entryBucket}:${timeBucket}`;
    clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }

  let upWeight = 0;
  let downWeight = 0;
  let totalWeight = 0;
  let totalEpisodeCount = 0;
  let matchedSession = 0;
  let matchedRegime = 0;
  let matchedTarget = 0;
  let shortVotes = 0;
  let longVotes = 0;
  const expectedTarget = targetCohort(targetBand);

  for (const wallet of active) {
    const memberships = membershipSet(wallet);
    const entryBucket = Math.round(Number(wallet.positionEntryPrice ?? 0) * 10) / 10;
    const timeBucket = Math.floor(wallet.positionUpdatedAt / (5 * 60 * 1_000));
    const clusterKey = `${wallet.positionSide}:${entryBucket}:${timeBucket}`;
    const clusterPenalty = 1 / Math.sqrt(clusters.get(clusterKey) ?? 1);
    const ageHours = Math.max(0, now - wallet.positionUpdatedAt) / HOUR_MS;
    const recency = Math.exp(-ageHours / 12);
    const sideQuality = wallet.positionSide === 'LONG'
      ? wallet.score.longQuality
      : wallet.score.shortQuality;
    let contextMultiplier = 1;
    if (memberships.has(`SESSION_${session}`)) {
      contextMultiplier *= 1.12;
      matchedSession += 1;
    }
    if (memberships.has(`REGIME_${regime}`)) {
      contextMultiplier *= 1.18;
      matchedRegime += 1;
    }
    if (memberships.has(expectedTarget)) {
      contextMultiplier *= 1.2;
      matchedTarget += 1;
    }
    if (memberships.has(`WHALE_CONVICTION_${wallet.positionSide}`)) {
      contextMultiplier *= 1.12;
    }
    const weight =
      clamp(wallet.score.overallScore) *
      clamp(sideQuality) *
      recency *
      clusterPenalty *
      contextMultiplier;
    if (weight <= 0) continue;
    totalWeight += weight;
    totalEpisodeCount += Number(wallet.score.episodeCount ?? 0);
    if (wallet.positionSide === 'LONG') {
      upWeight += weight;
      longVotes += 1;
    } else {
      downWeight += weight;
      shortVotes += 1;
    }
  }

  if (totalWeight <= 0) {
    return {
      status: 'warming',
      probabilityUp: 0.5,
      probabilityDown: 0.5,
      confidence: 0,
      maturity: 0,
      cohortSize: active.length,
      reasons: ['active cohorts have insufficient matched evidence'],
      diagnostics: { clusterCount: clusters.size, totalEpisodeCount },
    };
  }

  const probabilityUp = upWeight / totalWeight;
  const probabilityDown = downWeight / totalWeight;
  const maturity = clamp(
    (Math.min(1, active.length / 20) * 0.45) +
    (Math.min(1, totalEpisodeCount / 200) * 0.55),
  );
  const confidence = clamp(
    Math.abs(probabilityUp - probabilityDown) * Math.min(1, totalWeight / 3),
  );
  const reasons = [
    `${shortVotes} verified traders currently hold SHORT; ${longVotes} hold LONG`,
  ];
  if (matchedRegime > 0) reasons.push(`${matchedRegime} traders match ${regime} regime`);
  if (matchedSession > 0) reasons.push(`${matchedSession} traders match ${session} session`);
  if (matchedTarget > 0) reasons.push(`${matchedTarget} traders match ${targetBand} target band`);

  return {
    status: 'ready',
    probabilityUp: round(probabilityUp, 8),
    probabilityDown: round(probabilityDown, 8),
    confidence: round(confidence, 6),
    maturity: round(maturity, 6),
    cohortSize: active.length,
    reasons,
    diagnostics: {
      clusterCount: clusters.size,
      totalEpisodeCount,
    },
  };
}

const phaseWeight = (setup) => {
  if (setup.stage === 'funded') return clamp(setup.profitSplit, 0.1, 1);
  if (setup.stage === 'p2') return 0.25;
  return 0.15;
};

const calculateCandidateEconomics = ({
  setup,
  fpDirection,
  probabilities,
}) => {
  const funded = setup.stage === 'funded';
  const riskPct = funded ? Number(setup.fundedRisk) : Number(setup.riskPerTrade);
  const fundingPipsRiskUsd = (Number(setup.accountSize) * riskPct) / 100;
  const fundingPipsWeight = phaseWeight(setup);
  const bybitWin = Number(setup.bybitStake);
  const bybitLoss = bybitWin * Number(setup.rrRatio);
  const fpLossEquivalent = fundingPipsRiskUsd * fundingPipsWeight;
  const fpWinEquivalent =
    fundingPipsRiskUsd * Number(setup.rrRatio) * fundingPipsWeight;
  const bybitTpPathValue = bybitWin - fpLossEquivalent;
  const fundingPipsTpPathValue = fpWinEquivalent - bybitLoss;
  const bybitTpProbability = fpDirection === 'long'
    ? probabilities.down
    : probabilities.up;
  const fundingPipsTpProbability = fpDirection === 'long'
    ? probabilities.up
    : probabilities.down;

  return {
    bybitTpProbability,
    fundingPipsTpProbability,
    expectedValueUsdEquivalent: round(
      (bybitTpProbability * bybitTpPathValue) +
      (fundingPipsTpProbability * fundingPipsTpPathValue),
      2,
    ),
    bybitTpPathValue: round(bybitTpPathValue, 2),
    fundingPipsTpPathValue: round(fundingPipsTpPathValue, 2),
  };
};

const candidateScore = (candidate, intent) => {
  if (intent === 'transfer-to-bybit') return candidate.bybitTpProbability;
  if (intent === 'transfer-to-fundingpips') return candidate.fundingPipsTpProbability;
  return candidate.expectedValueUsdEquivalent;
};

const combineProbabilities = ({
  market,
  wallet,
  walletWeight,
}) => {
  const touchProbability = market.up + market.down;
  const walletUp = touchProbability * wallet.probabilityUp;
  const walletDown = touchProbability * wallet.probabilityDown;
  const up = ((1 - walletWeight) * market.up) + (walletWeight * walletUp);
  const down = ((1 - walletWeight) * market.down) + (walletWeight * walletDown);
  const neither = market.neither;
  const total = up + down + neither;
  return {
    up: round(up / total, 10),
    down: round(down / total, 10),
    neither: round(neither / total, 10),
  };
};

export function buildPhaseAwareRecommendation({
  snapshot,
  setup,
  wallets = [],
  modelMetrics = { resolvedCount: 0, brierScore: null },
  intent = 'best-expected-value',
  horizonMs = DEFAULT_HORIZON_MS,
}) {
  if (
    !['transfer-to-bybit', 'transfer-to-fundingpips', 'best-expected-value'].includes(intent)
  ) {
    throw new Error('Unknown intelligence intent.');
  }
  const required = [
    'entryPrice',
    'slPct',
    'rrRatio',
    'accountSize',
    'riskPerTrade',
    'fundedRisk',
    'profitSplit',
    'bybitStake',
  ];
  if (
    !snapshot ||
    !setup ||
    required.some((key) => !Number.isFinite(Number(setup[key])) || Number(setup[key]) <= 0) ||
    !['p1', 'p2', 'funded'].includes(setup.stage)
  ) {
    throw new Error('Phase-aware setup is invalid.');
  }

  const marketReference = buildMarketOnlyForecast({
    snapshot,
    setup: { ...setup, fpDirection: 'long' },
    horizonMs,
  });
  const targetBand = targetBandForPct(setup.slPct);
  const walletSignal = buildWalletSignal({
    wallets,
    session: snapshot.market?.session ?? 'UNKNOWN',
    regime: marketReference.regime,
    targetBand,
    now: snapshot.generatedAt,
  });
  const calibrationMaturity = clamp(Number(modelMetrics.resolvedCount ?? 0) / 500);
  const maturity = clamp(
    (walletSignal.maturity * 0.7) +
    (calibrationMaturity * 0.3),
  );
  const brierScore = Number(modelMetrics.brierScore);
  const calibrationQuality = Number.isFinite(brierScore)
    ? clamp(1 - (brierScore / 0.5), 0.25, 1)
    : 0.5;
  const walletWeight = walletSignal.status === 'ready'
    ? Math.min(0.6, (0.1 + (maturity * 0.5)) * calibrationQuality)
    : 0;

  const candidates = {};
  for (const fpDirection of ['long', 'short']) {
    const marketForecast = fpDirection === 'long'
      ? marketReference
      : buildMarketOnlyForecast({
        snapshot,
        setup: { ...setup, fpDirection },
        horizonMs,
      });
    const probabilities = combineProbabilities({
      market: marketForecast.probabilities,
      wallet: walletSignal,
      walletWeight,
    });
    const economics = calculateCandidateEconomics({
      setup,
      fpDirection,
      probabilities,
    });
    candidates[fpDirection] = {
      fpDirection,
      bybitDirection: fpDirection === 'long' ? 'SHORT' : 'LONG',
      probabilities,
      marketForecast,
      ...economics,
      score: candidateScore(economics, intent),
    };
  }

  const ordered = Object.values(candidates).sort((left, right) => right.score - left.score);
  const selected = ordered[0];
  const alternate = ordered[1];
  const rawEdge = intent === 'best-expected-value'
    ? Math.abs(selected.score - alternate.score) / Math.max(
      1,
      Math.abs(selected.score),
      Math.abs(alternate.score),
    )
    : Math.abs(selected.score - alternate.score);
  const edge = clamp(rawEdge);
  const selectedMarketProbability = selected.fpDirection === 'long'
    ? selected.marketForecast.probabilities.down
    : selected.marketForecast.probabilities.up;
  const selectedWalletProbability = selected.fpDirection === 'long'
    ? walletSignal.probabilityDown
    : walletSignal.probabilityUp;
  const combinedSignal = selected.bybitTpProbability;
  const confidence = clamp(
    (selected.marketForecast.confidence * (1 - walletWeight)) +
    (walletSignal.confidence * walletWeight) +
    (edge * 0.25),
  );
  const noEdge =
    edge < 0.05 ||
    (
      marketReference.regime === 'RANGE' &&
      walletSignal.status !== 'ready' &&
      edge < 0.1
    );
  const stale = snapshot.status !== 'live' ||
    snapshot.market?.hyperliquid?.stale !== false ||
    snapshot.market?.bybit?.stale !== false;
  const status = stale ? 'stale' : noEdge ? 'no_edge' : 'ready';
  const fpLong = selected.fpDirection === 'long';
  const reasons = [
    ...selected.marketForecast.reasons,
    ...walletSignal.reasons,
  ].slice(0, 6);

  return {
    version: 1,
    status,
    generatedAt: snapshot.generatedAt,
    intent,
    horizonMs,
    regime: selected.marketForecast.regime,
    targetBand,
    recommendation: {
      fpDirection: selected.fpDirection,
      bybitDirection: selected.bybitDirection,
      autoEligible: status === 'ready' && confidence >= 0.12 && edge >= 0.05,
    },
    paths: {
      down: {
        probability: selected.probabilities.down,
        label: fpLong ? 'BB TP / FP SL' : 'BB SL / FP TP',
      },
      up: {
        probability: selected.probabilities.up,
        label: fpLong ? 'BB SL / FP TP' : 'BB TP / FP SL',
      },
      neither: {
        probability: selected.probabilities.neither,
        label: 'No barrier inside horizon',
      },
    },
    marketSignal: round(selectedMarketProbability, 8),
    walletSignal: round(selectedWalletProbability, 8),
    combinedSignal: round(combinedSignal, 8),
    walletWeight: round(walletWeight, 6),
    confidence: round(confidence, 6),
    maturity: round(maturity, 6),
    cohortSize: walletSignal.cohortSize,
    edge: round(edge, 6),
    reasons,
    candidates: {
      long: {
        bybitTpProbability: round(candidates.long.bybitTpProbability, 8),
        fundingPipsTpProbability: round(candidates.long.fundingPipsTpProbability, 8),
        expectedValueUsdEquivalent: candidates.long.expectedValueUsdEquivalent,
      },
      short: {
        bybitTpProbability: round(candidates.short.bybitTpProbability, 8),
        fundingPipsTpProbability: round(candidates.short.fundingPipsTpProbability, 8),
        expectedValueUsdEquivalent: candidates.short.expectedValueUsdEquivalent,
      },
    },
    economics: {
      phase: setup.stage,
      includesFeesOrSpread: false,
      executionEnabled: false,
      valueType: setup.stage === 'funded'
        ? 'withdrawable-equivalent'
        : 'challenge-progress-equivalent',
    },
    diagnostics: {
      walletStatus: walletSignal.status,
      clusterCount: walletSignal.diagnostics.clusterCount,
      resolvedPredictionCount: Number(modelMetrics.resolvedCount ?? 0),
    },
  };
}

export function createRecommendationStabilizer({
  now = Date.now,
  minimumConsecutive = 3,
  cooldownMs = 120_000,
} = {}) {
  if (
    !Number.isInteger(minimumConsecutive) ||
    minimumConsecutive < 1 ||
    minimumConsecutive > 20 ||
    !Number.isSafeInteger(cooldownMs) ||
    cooldownMs < 0
  ) {
    throw new Error('Stabilizer configuration is invalid.');
  }
  let candidateDirection = null;
  let consecutive = 0;
  let activeDirection = null;
  let switchAllowedAt = 0;

  return {
    update(result) {
      const direction = result?.recommendation?.autoEligible
        ? result.recommendation.fpDirection
        : null;
      if (!['long', 'short'].includes(direction)) {
        candidateDirection = null;
        consecutive = 0;
        return {
          stable: activeDirection !== null,
          direction: activeDirection,
          changed: false,
          switchAllowedAt,
        };
      }
      if (direction === candidateDirection) consecutive += 1;
      else {
        candidateDirection = direction;
        consecutive = 1;
      }

      let changed = false;
      const currentTime = now();
      if (consecutive >= minimumConsecutive) {
        if (activeDirection === null) {
          activeDirection = candidateDirection;
          switchAllowedAt = currentTime + cooldownMs;
          changed = true;
        } else if (
          candidateDirection !== activeDirection &&
          currentTime >= switchAllowedAt
        ) {
          activeDirection = candidateDirection;
          switchAllowedAt = currentTime + cooldownMs;
          changed = true;
        }
      }
      return {
        stable: activeDirection !== null,
        direction: activeDirection,
        changed,
        switchAllowedAt,
      };
    },
    reset() {
      candidateDirection = null;
      consecutive = 0;
      activeDirection = null;
      switchAllowedAt = 0;
    },
  };
}

