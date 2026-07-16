import { createHash } from 'node:crypto';

const DEFAULT_HORIZON_MS = 4 * 60 * 60 * 1_000;

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number(value)));

const round = (value, decimals = 8) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const directionSign = (value, threshold = 0) => {
  if (value > threshold) return 1;
  if (value < -threshold) return -1;
  return 0;
};

const softmax = (values) => {
  const maximum = Math.max(...values);
  const exponentials = values.map((value) => Math.exp(value - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
};

export function classifyMarketRegime(snapshot) {
  const features = snapshot?.features;
  if (!features) {
    return {
      regime: 'UNKNOWN',
      direction: 'NEUTRAL',
      confidence: 0,
      reasons: ['market features unavailable'],
    };
  }
  const momentum = Number(features.momentum15mBps ?? 0);
  const volatility = Math.abs(Number(features.volatilityBps ?? 0));
  const flow = Number(features.aggressiveFlow15m ?? 0);
  const book = Number(features.bookImbalance ?? 0);
  const momentumSide = directionSign(momentum, 4);
  const flowSide = directionSign(flow, 0.08);
  const bookSide = directionSign(book, 0.08);
  const alignedFlow = momentumSide !== 0 && flowSide === momentumSide;
  const alignedBook = momentumSide !== 0 && bookSide === momentumSide;
  const opposingFlow = momentumSide !== 0 && (
    flowSide === -momentumSide || bookSide === -momentumSide
  );

  if (
    Math.abs(momentum) >= 20 &&
    Math.abs(flow) >= 0.2 &&
    alignedFlow &&
    alignedBook
  ) {
    return {
      regime: 'BREAKOUT',
      direction: momentumSide > 0 ? 'UP' : 'DOWN',
      confidence: round(clamp(
        0.5 + (Math.abs(momentum) / 160) + (Math.abs(flow) * 0.2),
      ), 6),
      reasons: ['momentum, aggressive flow, and book are aligned'],
    };
  }
  if (Math.abs(momentum) >= 20 && opposingFlow) {
    return {
      regime: 'REVERSAL',
      direction: momentumSide > 0 ? 'DOWN' : 'UP',
      confidence: round(clamp(
        0.45 + (Math.abs(flow) * 0.25) + (Math.abs(book) * 0.15),
      ), 6),
      reasons: ['flow or order-book pressure opposes the recent move'],
    };
  }
  if (
    Math.abs(momentum) < 8 &&
    volatility < 5 &&
    Math.abs(flow) < 0.15 &&
    Math.abs(book) < 0.15
  ) {
    return {
      regime: 'RANGE',
      direction: 'NEUTRAL',
      confidence: round(clamp(0.7 - (volatility / 20)), 6),
      reasons: ['momentum, volatility, and flow remain compressed'],
    };
  }
  return {
    regime: 'TREND',
    direction: momentumSide > 0 ? 'UP' : momentumSide < 0 ? 'DOWN' : 'NEUTRAL',
    confidence: round(clamp(
      0.35 + (Math.abs(momentum) / 120) + (Math.abs(flow) * 0.15),
    ), 6),
    reasons: ['market is directional without full breakout confirmation'],
  };
}

export function buildBarrierDefinition({
  entryPrice,
  slPct,
  rrRatio,
  fpDirection,
  horizonMs = DEFAULT_HORIZON_MS,
  createdAt,
}) {
  if (
    !isPositive(entryPrice) ||
    !isPositive(slPct) ||
    !isPositive(rrRatio) ||
    !['long', 'short'].includes(fpDirection) ||
    !Number.isSafeInteger(horizonMs) ||
    horizonMs < 1_000 ||
    horizonMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0
  ) {
    throw new Error('Barrier setup is invalid.');
  }
  const stopDistance = (Number(entryPrice) * Number(slPct)) / 100;
  const targetDistance = stopDistance * Number(rrRatio);
  const fpLong = fpDirection === 'long';

  return {
    entryPrice: Number(entryPrice),
    upBarrier: round(Number(entryPrice) + (fpLong ? targetDistance : stopDistance)),
    downBarrier: round(Number(entryPrice) - (fpLong ? stopDistance : targetDistance)),
    upPath: fpLong ? 'BYBIT_SL_FP_TP' : 'BYBIT_TP_FP_SL',
    downPath: fpLong ? 'BYBIT_TP_FP_SL' : 'BYBIT_SL_FP_TP',
    expiresAt: createdAt + horizonMs,
  };
}

export function buildMarketOnlyForecast({
  snapshot,
  setup,
  horizonMs = DEFAULT_HORIZON_MS,
}) {
  if (!snapshot || !setup) throw new Error('Market snapshot and setup are required.');
  const generatedAt = Number(snapshot.generatedAt);
  const barrier = buildBarrierDefinition({
    ...setup,
    horizonMs,
    createdAt: generatedAt,
  });
  const bybitMid = Number(snapshot.market?.bybit?.mid);
  const hyperliquidMid = Number(snapshot.market?.hyperliquid?.mid);
  if (
    !isPositive(bybitMid) ||
    !isPositive(hyperliquidMid) ||
    !snapshot.features
  ) {
    return {
      status: 'warming',
      regime: 'UNKNOWN',
      confidence: 0,
      probabilities: { up: 0, down: 0, neither: 1 },
      reasons: ['waiting for synchronized Hyperliquid and Bybit market state'],
      barrier,
    };
  }

  const features = snapshot.features;
  const regime = classifyMarketRegime(snapshot);
  const momentum15 = Number(features.momentum15mBps ?? 0);
  const momentum5 = Number(features.momentum5mBps ?? 0);
  const flow15 = Number(features.aggressiveFlow15m ?? 0);
  const flow5 = Number(features.aggressiveFlow5m ?? 0);
  const book = Number(features.bookImbalance ?? 0);
  const oiChange = Number(features.openInterestChangePct ?? 0);
  const basis = Number(snapshot.market.basisBps ?? 0);
  const premium = Number(snapshot.market.hyperliquid.premium ?? 0);
  const momentumSide = directionSign(momentum15);

  let directionalScore =
    (clamp(momentum15 / 40, -1, 1) * 0.35) +
    (clamp(flow15, -1, 1) * 0.25) +
    (clamp(flow5, -1, 1) * 0.1) +
    (clamp(book, -1, 1) * 0.15) +
    (momentumSide * clamp(Math.abs(oiChange) / 0.5, 0, 1) * 0.08) +
    (clamp(basis / 10, -1, 1) * 0.03) -
    (clamp(premium / 0.002, -1, 1) * 0.04);

  if (regime.regime === 'BREAKOUT') {
    directionalScore += regime.direction === 'UP' ? 0.15 : -0.15;
  } else if (regime.regime === 'REVERSAL') {
    directionalScore += regime.direction === 'UP' ? 0.12 : -0.12;
  } else if (regime.regime === 'RANGE') {
    directionalScore *= 0.45;
  }
  directionalScore = clamp(directionalScore, -1, 1);

  const upDistanceBps = ((barrier.upBarrier / barrier.entryPrice) - 1) * 10_000;
  const downDistanceBps = (1 - (barrier.downBarrier / barrier.entryPrice)) * 10_000;
  const horizonMinutes = horizonMs / 60_000;
  const volatilityScale = clamp(
    (
      Math.abs(Number(features.volatilityBps ?? 0)) *
      Math.sqrt(horizonMinutes / 15)
    ) + (
      Math.abs(momentum5) *
      Math.sqrt(horizonMinutes / 5)
    ),
    30,
    120,
  );
  const upLogit = (directionalScore * 2.4) - (upDistanceBps / volatilityScale);
  const downLogit = (-directionalScore * 2.4) - (downDistanceBps / volatilityScale);
  const neitherLogit =
    (Math.min(upDistanceBps, downDistanceBps) / volatilityScale) - 1.1;
  const [up, down, neither] = softmax([upLogit, downLogit, neitherLogit]);
  const directionalEdge = Math.abs(up - down);
  const dataFreshness = snapshot.status === 'live' &&
    snapshot.market.hyperliquid.stale === false &&
    snapshot.market.bybit.stale === false
    ? 1
    : 0.45;
  const confidence = clamp(
    (directionalEdge * 1.35) *
    (0.65 + (regime.confidence * 0.35)) *
    dataFreshness,
  );
  const reasons = [
    ...regime.reasons,
    `15m aggressive flow ${(flow15 * 100).toFixed(0)}%`,
    `book imbalance ${(book * 100).toFixed(0)}%`,
  ];
  if (Math.abs(oiChange) >= 0.05) {
    reasons.push(`open interest change ${oiChange >= 0 ? '+' : ''}${oiChange.toFixed(2)}%`);
  }

  return {
    status: snapshot.status === 'live' ? 'ready' : 'stale',
    generatedAt,
    regime: regime.regime,
    regimeDirection: regime.direction,
    directionalScore: round(directionalScore, 6),
    confidence: round(confidence, 6),
    horizonMs,
    probabilities: {
      up: round(up, 10),
      down: round(down, 10),
      neither: round(neither, 10),
    },
    reasons,
    barrier,
  };
}

export function createPredictionRecord({
  forecast,
  setup,
  createdAt,
  horizonMs = DEFAULT_HORIZON_MS,
}) {
  if (forecast?.status !== 'ready' && forecast?.status !== 'stale') {
    throw new Error('Only a usable forecast can be recorded.');
  }
  const barrier = buildBarrierDefinition({
    ...setup,
    createdAt,
    horizonMs,
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({
    minute: Math.floor(createdAt / 60_000),
    entryPrice: Number(setup.entryPrice),
    slPct: Number(setup.slPct),
    rrRatio: Number(setup.rrRatio),
    fpDirection: setup.fpDirection,
    stage: setup.stage,
  })).digest('hex');

  return {
    fingerprint,
    createdAt,
    expiresAt: barrier.expiresAt,
    entryPrice: barrier.entryPrice,
    upBarrier: barrier.upBarrier,
    downBarrier: barrier.downBarrier,
    fpDirection: setup.fpDirection,
    stage: setup.stage,
    session: setup.session ?? 'UNKNOWN',
    regime: forecast.regime,
    confidence: forecast.confidence,
    probabilityUp: forecast.probabilities.up,
    probabilityDown: forecast.probabilities.down,
    probabilityNeither: forecast.probabilities.neither,
    marketProbability: setup.fpDirection === 'long'
      ? forecast.probabilities.down
      : forecast.probabilities.up,
    walletProbability: null,
    combinedProbability: setup.fpDirection === 'long'
      ? forecast.probabilities.down
      : forecast.probabilities.up,
    maturity: 0,
  };
}
