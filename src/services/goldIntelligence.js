const STREAM_URL = '/api/intelligence/stream';
const STATUSES = new Set([
  'ready',
  'no_edge',
  'warming',
  'stale',
  'degraded',
  'error',
]);
const INTENTS = new Set([
  'transfer-to-bybit',
  'transfer-to-fundingpips',
  'best-expected-value',
]);
const FORBIDDEN_KEYS = new Set([
  'address',
  'wallets',
  'walletWeight',
  'seed',
  'seeds',
  'privateKey',
  'fills',
]);

const isProbability = (value) => (
  Number.isFinite(Number(value)) &&
  Number(value) >= 0 &&
  Number(value) <= 1
);

const hasForbiddenData = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenData);
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || hasForbiddenData(nested)) return true;
  }
  return false;
};

const validPath = (path) => (
  path &&
  isProbability(path.probability) &&
  typeof path.label === 'string' &&
  path.label.length >= 1 &&
  path.label.length <= 80
);

const validCandidate = (candidate) => {
  if (
    !candidate ||
    !isProbability(candidate.bybitTpProbability) ||
    !isProbability(candidate.fundingPipsTpProbability) ||
    !isProbability(candidate.marketBybitTpProbability) ||
    !isProbability(candidate.walletBybitTpProbability) ||
    !Number.isFinite(Number(candidate.expectedValueUsdEquivalent))
  ) {
    return false;
  }
  const probabilities = candidate.probabilities;
  if (
    !probabilities ||
    !isProbability(probabilities.up) ||
    !isProbability(probabilities.down) ||
    !isProbability(probabilities.neither)
  ) {
    return false;
  }
  return Math.abs(
    Number(probabilities.up) +
    Number(probabilities.down) +
    Number(probabilities.neither) -
    1,
  ) <= 1e-6;
};

const validMarketSentiment = (sentiment) => {
  if (!sentiment) return true;
  if (
    !['ready', 'warming', 'stale'].includes(sentiment.status) ||
    !['LONG', 'SHORT', 'NEUTRAL'].includes(sentiment.direction) ||
    (
      sentiment.score !== null &&
      (
        !Number.isFinite(Number(sentiment.score)) ||
        Number(sentiment.score) < -100 ||
        Number(sentiment.score) > 100
      )
    ) ||
    !Number.isFinite(Number(sentiment.strength)) ||
    Number(sentiment.strength) < 0 ||
    Number(sentiment.strength) > 100 ||
    !Number.isFinite(Number(sentiment.generatedAt)) ||
    !Number.isFinite(Number(sentiment.stableForMs)) ||
    Number(sentiment.stableForMs) < 0 ||
    !Array.isArray(sentiment.reasons) ||
    sentiment.reasons.length > 8 ||
    sentiment.reasons.some((reason) => typeof reason !== 'string' || reason.length > 240) ||
    !sentiment.components ||
    typeof sentiment.components !== 'object' ||
    Array.isArray(sentiment.components)
  ) {
    return false;
  }
  return Object.values(sentiment.components).every((item) => (
    item &&
    Number.isFinite(Number(item.weight)) &&
    Number(item.weight) >= 0 &&
    Number(item.weight) <= 100 &&
    Number.isFinite(Number(item.raw)) &&
    Number(item.raw) >= -1 &&
    Number(item.raw) <= 1 &&
    Number.isFinite(Number(item.value)) &&
    Math.abs(Number(item.value)) <= Number(item.weight)
  ));
};

const validWhaleSentiment = (sentiment) => {
  if (!sentiment) return true;
  return (
    ['ready', 'warming', 'stale'].includes(sentiment.status) &&
    ['LONG', 'SHORT', 'NEUTRAL'].includes(sentiment.direction) &&
    (
      sentiment.score === null ||
      (
        Number.isFinite(Number(sentiment.score)) &&
        Number(sentiment.score) >= -100 &&
        Number(sentiment.score) <= 100
      )
    ) &&
    Number.isInteger(sentiment.qualifiedCount) &&
    sentiment.qualifiedCount >= 0 &&
    sentiment.qualifiedCount <= 100_000 &&
    Number.isInteger(sentiment.newPositions15m?.long) &&
    sentiment.newPositions15m.long >= 0 &&
    Number.isInteger(sentiment.newPositions15m?.short) &&
    sentiment.newPositions15m.short >= 0 &&
    ['LOW', 'MEDIUM', 'HIGH'].includes(sentiment.conviction) &&
    Number.isFinite(Number(sentiment.maturity)) &&
    Number(sentiment.maturity) >= 0 &&
    Number(sentiment.maturity) <= 1 &&
    Array.isArray(sentiment.reasons) &&
    sentiment.reasons.length <= 8
  );
};

const validCombinedSentiment = (sentiment) => {
  if (!sentiment) return true;
  return (
    ['ready', 'warming', 'stale'].includes(sentiment.status) &&
    ['LONG', 'SHORT', 'NEUTRAL'].includes(sentiment.direction) &&
    (
      sentiment.score === null ||
      (
        Number.isFinite(Number(sentiment.score)) &&
        Number(sentiment.score) >= -100 &&
        Number(sentiment.score) <= 100
      )
    ) &&
    Number.isFinite(Number(sentiment.strength)) &&
    Number(sentiment.strength) >= 0 &&
    Number(sentiment.strength) <= 100 &&
    ['MARKET_ONLY', 'MARKET_WHALE'].includes(sentiment.source)
  );
};

const validWalletState = (state) => {
  if (!state) return true;
  return (
    ['ready', 'warming', 'stale'].includes(state.status) &&
    Number.isFinite(Number(state.maturity)) &&
    Number(state.maturity) >= 0 &&
    Number(state.maturity) <= 1 &&
    Number.isInteger(state.qualifiedCount) &&
    state.qualifiedCount >= 0 &&
    Number.isFinite(Number(state.weight)) &&
    Number(state.weight) >= 0 &&
    Number(state.weight) <= 0.55
  );
};

const DECISION_STATES = new Set([
  'WARMING',
  'NEUTRAL',
  'WATCH_LONG',
  'WATCH_SHORT',
  'CONFIRMED_LONG',
  'CONFIRMED_SHORT',
  'COOLDOWN_LONG',
  'COOLDOWN_SHORT',
  'LOCKED_LONG',
  'LOCKED_SHORT',
  'STALE',
]);

const validDecision = (decision) => {
  if (!decision) return true;
  if (
    !DECISION_STATES.has(decision.state) ||
    ![null, 'long', 'short'].includes(decision.fpDirection) ||
    ![null, 'LONG', 'SHORT'].includes(decision.bybitDirection) ||
    typeof decision.autoEligible !== 'boolean' ||
    !isProbability(decision.confidence) ||
    !isProbability(decision.edge) ||
    !['MARKET_ONLY', 'COMBINED'].includes(decision.source) ||
    !Array.isArray(decision.reasons) ||
    decision.reasons.length > 8
  ) {
    return false;
  }
  if (decision.fpDirection === null) {
    return decision.bybitDirection === null &&
      decision.probabilities === null &&
      decision.paths === null &&
      decision.autoEligible === false;
  }
  if (
    decision.bybitDirection !== (decision.fpDirection === 'long' ? 'SHORT' : 'LONG') ||
    !decision.probabilities ||
    !isProbability(decision.probabilities.down) ||
    !isProbability(decision.probabilities.up) ||
    !isProbability(decision.probabilities.neither) ||
    !validPath(decision.paths?.down) ||
    !validPath(decision.paths?.up) ||
    !validPath(decision.paths?.neither)
  ) {
    return false;
  }
  const sum =
    Number(decision.probabilities.down) +
    Number(decision.probabilities.up) +
    Number(decision.probabilities.neither);
  const expectedDown = decision.fpDirection === 'long'
    ? 'BB TP / FP SL'
    : 'BB SL / FP TP';
  const expectedUp = decision.fpDirection === 'long'
    ? 'BB SL / FP TP'
    : 'BB TP / FP SL';
  return (
    Math.abs(sum - 1) <= 1e-6 &&
    decision.paths.down.label === expectedDown &&
    decision.paths.up.label === expectedUp &&
    Math.abs(decision.paths.down.probability - decision.probabilities.down) <= 1e-6 &&
    Math.abs(decision.paths.up.probability - decision.probabilities.up) <= 1e-6 &&
    Math.abs(decision.paths.neither.probability - decision.probabilities.neither) <= 1e-6
  );
};

export function parseGoldIntelligenceSnapshot(payload) {
  let snapshot;
  try {
    snapshot = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }
  if (
    !snapshot ||
    hasForbiddenData(snapshot) ||
    snapshot.version !== 1 ||
    !STATUSES.has(snapshot.status) ||
    !Number.isFinite(Number(snapshot.generatedAt)) ||
    !INTENTS.has(snapshot.intent) ||
    !Number.isFinite(Number(snapshot.horizonMs)) ||
    typeof snapshot.regime !== 'string' ||
    typeof snapshot.targetBand !== 'string' ||
    !['long', 'short'].includes(snapshot.recommendation?.fpDirection) ||
    !['LONG', 'SHORT'].includes(snapshot.recommendation?.bybitDirection) ||
    typeof snapshot.recommendation.autoEligible !== 'boolean' ||
    ![null, 'long', 'short'].includes(snapshot.recommendation.stableDirection) ||
    typeof snapshot.recommendation.stable !== 'boolean' ||
    !validPath(snapshot.paths?.down) ||
    !validPath(snapshot.paths?.up) ||
    !validPath(snapshot.paths?.neither) ||
    !isProbability(snapshot.marketSignal) ||
    !isProbability(snapshot.walletSignal) ||
    !isProbability(snapshot.combinedSignal) ||
    !isProbability(snapshot.confidence) ||
    !isProbability(snapshot.maturity) ||
    !isProbability(snapshot.edge) ||
    !Number.isInteger(snapshot.cohortSize) ||
    snapshot.cohortSize < 0 ||
    snapshot.cohortSize > 100_000 ||
    !Array.isArray(snapshot.reasons) ||
    snapshot.reasons.length > 8 ||
    snapshot.reasons.some((reason) => typeof reason !== 'string' || reason.length > 240) ||
    !validCandidate(snapshot.candidates?.long) ||
    !validCandidate(snapshot.candidates?.short) ||
    !validMarketSentiment(snapshot.sentiment?.market) ||
    !validWhaleSentiment(snapshot.sentiment?.whale) ||
    !validCombinedSentiment(snapshot.sentiment?.combined) ||
    !validWalletState(snapshot.walletState) ||
    !validDecision(snapshot.decision) ||
    snapshot.economics?.includesFeesOrSpread !== false ||
    snapshot.economics?.executionEnabled !== false ||
    snapshot.market?.symbol !== 'xyz:GOLD' ||
    snapshot.market?.bybitSymbol !== 'XAUUSD+'
  ) {
    return null;
  }
  const pathSum =
    Number(snapshot.paths.down.probability) +
    Number(snapshot.paths.up.probability) +
    Number(snapshot.paths.neither.probability);
  if (Math.abs(pathSum - 1) > 1e-6) return null;

  return {
    version: 1,
    status: snapshot.status,
    generatedAt: Number(snapshot.generatedAt),
    intent: snapshot.intent,
    horizonMs: Number(snapshot.horizonMs),
    regime: snapshot.regime,
    targetBand: snapshot.targetBand,
    recommendation: {
      fpDirection: snapshot.recommendation.fpDirection,
      bybitDirection: snapshot.recommendation.bybitDirection,
      autoEligible: snapshot.recommendation.autoEligible,
      stableDirection: snapshot.recommendation.stableDirection,
      stable: snapshot.recommendation.stable,
      switchAllowedAt: snapshot.recommendation.switchAllowedAt ?? null,
    },
    paths: snapshot.paths,
    marketSignal: Number(snapshot.marketSignal),
    walletSignal: Number(snapshot.walletSignal),
    combinedSignal: Number(snapshot.combinedSignal),
    confidence: Number(snapshot.confidence),
    maturity: Number(snapshot.maturity),
    cohortSize: snapshot.cohortSize,
    edge: Number(snapshot.edge),
    reasons: [...snapshot.reasons],
    candidates: snapshot.candidates,
    economics: snapshot.economics,
    ...(snapshot.decision ? { decision: snapshot.decision } : {}),
    ...(snapshot.sentiment ? { sentiment: snapshot.sentiment } : {}),
    ...(snapshot.walletState ? { walletState: snapshot.walletState } : {}),
    market: snapshot.market,
  };
}

export function buildGoldIntelligenceQuery(setup) {
  const fields = [
    'instrument',
    'entryPrice',
    'slPct',
    'rrRatio',
    'stage',
    'accountSize',
    'riskPerTrade',
    'fundedRisk',
    'profitSplit',
    'bybitStake',
    'intent',
  ];
  const query = new URLSearchParams();
  for (const field of fields) query.set(field, String(setup[field]));
  return query;
}

export function buildGoldIntelligenceContextKey(setup) {
  const fields = [
    'instrument',
    'slPct',
    'rrRatio',
    'stage',
    'accountSize',
    'riskPerTrade',
    'fundedRisk',
    'profitSplit',
    'bybitStake',
    'intent',
  ];
  return JSON.stringify(Object.fromEntries(
    fields.map((field) => [field, setup?.[field]]),
  ));
}

export function createGoldIntelligenceFeed({
  setup,
  onSnapshot = () => {},
  onStatus = () => {},
  onError = () => {},
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  let source;
  let stopped = true;

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      if (typeof EventSourceImpl !== 'function') {
        onError({ status: 'error', message: 'SSE недоступен в этом браузере.' });
        return;
      }
      onStatus({ status: 'connecting' });
      source = new EventSourceImpl(`${STREAM_URL}?${buildGoldIntelligenceQuery(setup)}`);
      source.addEventListener('open', () => {
        if (!stopped) onStatus({ status: 'connected' });
      });
      source.addEventListener('snapshot', (event) => {
        if (stopped) return;
        const snapshot = parseGoldIntelligenceSnapshot(event.data);
        if (!snapshot) {
          onError({
            status: 'error',
            message: 'HL Intelligence прислал некорректный агрегированный ответ.',
          });
          return;
        }
        onSnapshot(snapshot);
      });
      source.addEventListener('status', (event) => {
        if (stopped) return;
        try {
          const status = JSON.parse(event.data);
          onStatus({
            status: STATUSES.has(status?.status) ? status.status : 'degraded',
            message: typeof status?.message === 'string' ? status.message.slice(0, 240) : '',
          });
        } catch {
          onStatus({ status: 'degraded', message: 'Обновление модели временно недоступно.' });
        }
      });
      source.addEventListener('error', () => {
        if (!stopped) onStatus({ status: 'reconnecting' });
      });
    },
    stop() {
      stopped = true;
      source?.close();
      source = undefined;
    },
  };
}
