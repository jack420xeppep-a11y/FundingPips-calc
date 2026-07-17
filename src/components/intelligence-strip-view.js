const stateLabels = {
  CONFIRMED_LONG: 'CONFIRMED',
  CONFIRMED_SHORT: 'CONFIRMED',
  COOLDOWN_LONG: 'COOLDOWN',
  COOLDOWN_SHORT: 'COOLDOWN',
  WATCH_LONG: 'WATCH',
  WATCH_SHORT: 'WATCH',
  WARMING: 'WARMING',
  SYNCING: 'SYNCING',
  EXPIRED: 'EXPIRED',
};

const pathDefinitions = [
  ['down', 'DOWN'],
  ['up', 'UP'],
  ['neither', 'NEITHER'],
];

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(Number(milliseconds ?? 0) / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const readProbability = (paths, key) => {
  const rawValue = paths?.[key]?.probability;
  if (rawValue === null || rawValue === undefined) return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
};

export const formatProbability = (value) => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? `${Math.round(Number(value) * 100)}%`
  : '—';

export function buildIntelligenceStripView({
  liveSnapshot = {},
  tradeSnapshot = null,
  locked = false,
  syncing = false,
}) {
  const decision = tradeSnapshot?.decision ?? liveSnapshot?.decision;
  const direction = decision?.fpDirection ??
    liveSnapshot?.recommendation?.stableDirection ??
    liveSnapshot?.recommendation?.fpDirection;
  const expired = tradeSnapshot?.expired === true;
  const stateName = expired
    ? 'EXPIRED'
    : locked
      ? 'LOCKED'
      : syncing
        ? 'SYNCING'
        : decision?.state ?? 'WARMING';
  const stateLabel = stateName === 'LOCKED'
    ? 'LOCKED'
    : stateLabels[stateName] ?? String(stateName).replaceAll('_', ' ');
  const actionable = !expired && !syncing && (
    locked ||
    decision?.autoEligible === true ||
    liveSnapshot?.recommendation?.autoEligible === true
  );
  const bybitDirection = direction === 'long' ? 'SHORT' : direction === 'short' ? 'LONG' : '—';
  const directionMode = locked
    ? 'LOCKED'
    : actionable
      ? 'SIGNAL'
      : direction
        ? 'BIAS'
        : 'WAIT';
  const sourcePaths = decision?.paths ?? liveSnapshot?.paths;
  const probabilities = pathDefinitions
    .map(([key]) => readProbability(sourcePaths, key))
    .filter((value) => value !== null);
  const maximum = probabilities.length > 0 ? Math.max(...probabilities) : null;
  const paths = pathDefinitions.map(([key, label]) => {
    const probability = readProbability(sourcePaths, key);
    return {
      key,
      label,
      probability,
      primary: probability !== null && probability === maximum,
    };
  });
  const generatedAt = tradeSnapshot?.createdAt ??
    liveSnapshot?.generatedAt ??
    decision?.generatedAt;
  const stableForMs = !syncing && decision?.stableSince
    ? Math.max(0, Number(generatedAt) - Number(decision.stableSince))
    : 0;
  const noteText = stateLabel === 'CONFIRMED' || stateLabel === 'LOCKED'
    ? `stable ${formatDuration(stableForMs)}`
    : stateLabel === 'WATCH'
      ? 'AUTO ждёт подтверждения'
      : stateLabel === 'COOLDOWN'
        ? 'направление удерживается'
        : stateLabel === 'SYNCING'
          ? 'синхронизация данных'
          : stateLabel === 'EXPIRED'
            ? 'snapshot устарел'
            : 'модель набирает историю';

  return {
    actionable,
    directionMode,
    directionText: direction
      ? `FP ${direction.toUpperCase()} / BB ${bybitDirection}`
      : 'FP — / BB —',
    noteText,
    paths,
    stableForMs,
    stateLabel,
  };
}
