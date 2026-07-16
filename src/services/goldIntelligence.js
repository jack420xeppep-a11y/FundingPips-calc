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

