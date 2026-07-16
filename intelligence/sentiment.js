import { classifyMarketRegime } from './market-model.js';

const DEFAULT_PUBLISH_INTERVAL_MS = 15_000;
const COMPONENT_WEIGHTS = Object.freeze({
  trendMomentum: 26,
  aggressiveFlow: 22,
  openInterest: 15,
  bookImbalance: 12,
  regime: 10,
  basisPremium: 8,
  sessionAlignment: 7,
});

const clamp = (value, minimum = -1, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number(value)));

const round = (value, decimals = 4) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const finite = (value, fallback = 0) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

const directionForScore = (score) => {
  if (score >= 8) return 'LONG';
  if (score <= -8) return 'SHORT';
  return 'NEUTRAL';
};

const directionSign = (direction) => {
  if (direction === 'UP') return 1;
  if (direction === 'DOWN') return -1;
  return 0;
};

const component = (weight, raw) => ({
  weight,
  raw: round(clamp(raw), 6),
  value: round(clamp(raw) * weight, 4),
});

const topReasons = (components, regime) => Object.entries(components)
  .filter(([, item]) => Math.abs(item.value) >= 1)
  .sort((left, right) => Math.abs(right[1].value) - Math.abs(left[1].value))
  .slice(0, 4)
  .map(([name, item]) => {
    const labels = {
      trendMomentum: 'trend and momentum',
      aggressiveFlow: 'aggressive tape',
      openInterest: 'open-interest alignment',
      bookImbalance: 'smoothed book pressure',
      regime: `${regime.toLowerCase()} regime`,
      basisPremium: 'Hyperliquid/Bybit basis',
      sessionAlignment: 'session alignment',
    };
    return `${labels[name]} ${item.value >= 0 ? 'supports LONG' : 'supports SHORT'}`;
  });

export function buildMarketSentiment(snapshot) {
  const stale = snapshot?.status !== 'live' ||
    snapshot?.market?.hyperliquid?.stale !== false ||
    snapshot?.market?.bybit?.stale !== false;
  if (stale || !snapshot?.features) {
    return {
      status: stale ? 'stale' : 'warming',
      direction: 'NEUTRAL',
      score: null,
      strength: 0,
      generatedAt: Number(snapshot?.generatedAt) || null,
      stableForMs: 0,
      components: {},
      reasons: ['waiting for synchronized market sentiment inputs'],
    };
  }

  const features = snapshot.features;
  const momentum5 = clamp(finite(features.momentum5mBps) / 25);
  const momentum15 = clamp(finite(features.momentum15mBps) / 45);
  const trendRaw = clamp((momentum15 * 0.65) + (momentum5 * 0.35));
  const flowRaw = clamp(
    (clamp(finite(features.aggressiveFlow15m)) * 0.65) +
    (clamp(finite(features.aggressiveFlow5m)) * 0.35),
  );
  const oiChange = Number.isFinite(Number(features.openInterestChange15mPct))
    ? Number(features.openInterestChange15mPct)
    : Number.isFinite(Number(features.openInterestChange5mPct))
      ? Number(features.openInterestChange5mPct)
      : 0;
  const trendSide = Math.sign(trendRaw);
  const openInterestRaw = trendSide * clamp(Math.max(0, oiChange) / 0.5, 0, 1);
  const bookRaw = clamp(finite(
    features.bookImbalanceEma,
    finite(features.bookImbalance),
  ));
  const regime = classifyMarketRegime({
    ...snapshot,
    features: {
      ...features,
      bookImbalance: bookRaw,
    },
  });
  const regimeRaw = directionSign(regime.direction) * clamp(regime.confidence, 0, 1);
  const basisRaw = clamp(finite(snapshot.market?.basisBps) / 10);
  const premiumRaw = clamp(-finite(snapshot.market?.hyperliquid?.premium) / 0.002);
  const basisPremiumRaw = clamp((basisRaw * 0.65) + (premiumRaw * 0.35));
  const sessionMultiplier = {
    LONDON: 1,
    NEW_YORK: 1,
    ASIA: 0.7,
    OFF_HOURS: 0.45,
  }[snapshot.market?.session] ?? 0.4;
  const sessionRaw = clamp(trendRaw * sessionMultiplier);

  const components = {
    trendMomentum: component(COMPONENT_WEIGHTS.trendMomentum, trendRaw),
    aggressiveFlow: component(COMPONENT_WEIGHTS.aggressiveFlow, flowRaw),
    openInterest: component(COMPONENT_WEIGHTS.openInterest, openInterestRaw),
    bookImbalance: component(COMPONENT_WEIGHTS.bookImbalance, bookRaw),
    regime: component(COMPONENT_WEIGHTS.regime, regimeRaw),
    basisPremium: component(COMPONENT_WEIGHTS.basisPremium, basisPremiumRaw),
    sessionAlignment: component(COMPONENT_WEIGHTS.sessionAlignment, sessionRaw),
  };
  const score = round(clamp(
    Object.values(components).reduce((sum, item) => sum + item.value, 0) / 100,
  ) * 100, 1);

  return {
    status: 'ready',
    direction: directionForScore(score),
    score,
    strength: Math.round(Math.abs(score)),
    generatedAt: Number(snapshot.generatedAt),
    stableForMs: 0,
    regime: regime.regime,
    components,
    reasons: topReasons(components, regime.regime),
  };
}

export function createMarketSentimentAggregator({
  now = Date.now,
  publishIntervalMs = DEFAULT_PUBLISH_INTERVAL_MS,
} = {}) {
  if (
    typeof now !== 'function' ||
    !Number.isSafeInteger(publishIntervalMs) ||
    publishIntervalMs < 1_000 ||
    publishIntervalMs > 60_000
  ) {
    throw new Error('Market sentiment aggregator configuration is invalid.');
  }

  let lastPublishedAt = 0;
  let stableSince = 0;
  let sentiment = null;

  return {
    update(snapshot, { force = false } = {}) {
      const currentTime = now();
      if (
        sentiment &&
        !force &&
        currentTime - lastPublishedAt < publishIntervalMs
      ) {
        return { published: false, sentiment };
      }

      const next = buildMarketSentiment(snapshot);
      if (!sentiment || next.direction !== sentiment.direction || next.status !== sentiment.status) {
        stableSince = currentTime;
      }
      sentiment = {
        ...next,
        generatedAt: currentTime,
        stableForMs: Math.max(0, currentTime - stableSince),
      };
      lastPublishedAt = currentTime;
      return { published: true, sentiment };
    },

    snapshot() {
      return sentiment;
    },
  };
}
