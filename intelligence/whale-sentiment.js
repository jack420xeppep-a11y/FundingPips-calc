const MIN_QUALIFIED_WALLETS = 3;
const MIN_MATURITY = 0.1;
const STALE_AFTER_MS = 30 * 60 * 1_000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

const WEIGHTS = Object.freeze({
  qualifiedPositions: 30,
  netChange15m: 25,
  netChange1h: 15,
  positionEvents15m: 15,
  unusualConviction: 10,
  entryCluster: 5,
});

const clamp = (value, minimum = -1, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number(value)));

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const signedValue = ({ side, positionValue }) => {
  const value = Math.abs(Number(positionValue) || 0);
  if (side === 'LONG') return value;
  if (side === 'SHORT') return -value;
  return 0;
};

const directionForScore = (score) => {
  if (score >= 8) return 'LONG';
  if (score <= -8) return 'SHORT';
  return 'NEUTRAL';
};

const weightedQuantile = (entries, quantile) => {
  const ordered = entries
    .filter((entry) => Number(entry.weight) > 0 && Number(entry.value) > 0)
    .sort((left, right) => left.value - right.value);
  const total = ordered.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  const target = total * quantile;
  let cumulative = 0;
  for (const entry of ordered) {
    cumulative += entry.weight;
    if (cumulative >= target) return round(entry.value, 4);
  }
  return round(ordered.at(-1).value, 4);
};

const median = (values) => {
  const ordered = values.filter((value) => value > 0).sort((left, right) => left - right);
  if (ordered.length === 0) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
};

const component = (weight, raw) => ({
  weight,
  raw: round(clamp(raw), 6),
  value: round(clamp(raw) * weight, 4),
});

const samplesByWallet = (samples) => {
  const grouped = new Map();
  for (const sample of samples) {
    if (
      typeof sample?.address !== 'string' ||
      !Number.isSafeInteger(sample.timestamp) ||
      !['LONG', 'SHORT', 'FLAT'].includes(sample.side)
    ) {
      continue;
    }
    const entries = grouped.get(sample.address) ?? [];
    entries.push(sample);
    grouped.set(sample.address, entries);
  }
  for (const entries of grouped.values()) {
    entries.sort((left, right) => left.timestamp - right.timestamp);
  }
  return grouped;
};

const baselineAt = (samples, timestamp) => {
  let baseline = null;
  for (const sample of samples) {
    if (sample.timestamp <= timestamp) baseline = sample;
    else break;
  }
  return baseline;
};

const positionEvents = (samples, from) => {
  const result = {
    long: 0,
    short: 0,
    longNotional: 0,
    shortNotional: 0,
    closeLongNotional: 0,
    closeShortNotional: 0,
  };
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (current.timestamp < from) continue;
    const previousSigned = signedValue(previous);
    const currentSigned = signedValue(current);
    if (current.side === 'LONG' && previous.side !== 'LONG') {
      result.long += 1;
      result.longNotional += Math.abs(currentSigned);
    }
    if (current.side === 'SHORT' && previous.side !== 'SHORT') {
      result.short += 1;
      result.shortNotional += Math.abs(currentSigned);
    }
    if (previous.side === 'LONG' && current.side !== 'LONG') {
      result.closeLongNotional += Math.abs(previousSigned);
    }
    if (previous.side === 'SHORT' && current.side !== 'SHORT') {
      result.closeShortNotional += Math.abs(previousSigned);
    }
  }
  return result;
};

export function buildWhaleSentiment({
  wallets,
  positionSamples,
  maturity,
  now,
}) {
  if (
    !Array.isArray(wallets) ||
    !Array.isArray(positionSamples) ||
    !Number.isFinite(Number(maturity)) ||
    !Number.isSafeInteger(now) ||
    now <= 0
  ) {
    throw new Error('Whale sentiment inputs are invalid.');
  }

  const qualified = wallets.filter((wallet) => (
    wallet?.status === 'ACTIVE_COHORT' &&
    ['LONG', 'SHORT'].includes(wallet.positionSide) &&
    Number.isFinite(Number(wallet.positionValue)) &&
    Number.isSafeInteger(wallet.positionUpdatedAt) &&
    Number(wallet.score?.overallScore) > 0
  ));
  const newestAt = qualified.reduce(
    (maximum, wallet) => Math.max(maximum, wallet.positionUpdatedAt),
    0,
  );
  const freshnessMs = newestAt > 0 ? Math.max(0, now - newestAt) : null;
  const warming = qualified.length < MIN_QUALIFIED_WALLETS || maturity < MIN_MATURITY;
  const stale = freshnessMs === null || freshnessMs > STALE_AFTER_MS;
  if (warming || stale) {
    return {
      status: stale && !warming ? 'stale' : 'warming',
      direction: 'NEUTRAL',
      score: null,
      strength: 0,
      qualifiedCount: qualified.length,
      newPositions15m: { long: 0, short: 0 },
      netPositionChange15m: null,
      netPositionChange1h: null,
      entryCluster: { p25: null, p75: null },
      conviction: 'LOW',
      freshnessMs,
      maturity: round(clamp(maturity, 0, 1), 4),
      reasons: [
        warming
          ? 'qualified whale cohort is still warming'
          : 'qualified whale positions are stale',
      ],
    };
  }

  const grouped = samplesByWallet(positionSamples);
  let currentNet = 0;
  let grossCurrent = 0;
  let delta15 = 0;
  let delta1h = 0;
  let unusualSigned = 0;
  const clusterEntries = [];
  const events = {
    long: 0,
    short: 0,
    longNotional: 0,
    shortNotional: 0,
    closeLongNotional: 0,
    closeShortNotional: 0,
  };

  for (const wallet of qualified) {
    const current = {
      side: wallet.positionSide,
      positionValue: wallet.positionValue,
    };
    const currentSigned = signedValue(current);
    const currentAbsolute = Math.abs(currentSigned);
    currentNet += currentSigned;
    grossCurrent += currentAbsolute;
    clusterEntries.push({
      value: Number(wallet.positionEntryPrice),
      weight: currentAbsolute * clamp(wallet.score.overallScore, 0, 1),
    });

    const samples = grouped.get(wallet.address) ?? [];
    const baseline15 = baselineAt(samples, now - FIFTEEN_MINUTES_MS);
    const baseline1h = baselineAt(samples, now - HOUR_MS);
    delta15 += currentSigned - signedValue(baseline15 ?? current);
    delta1h += currentSigned - signedValue(baseline1h ?? current);

    const walletEvents = positionEvents(samples, now - FIFTEEN_MINUTES_MS);
    for (const key of Object.keys(events)) events[key] += walletEvents[key];

    const historicalValues = samples.map((sample) => Math.abs(signedValue(sample)));
    const typical = median(historicalValues);
    const unusual = typical > 0 ? clamp((currentAbsolute / typical) - 1, 0, 2) / 2 : 0;
    unusualSigned += Math.sign(currentSigned) * currentAbsolute * unusual;
  }

  const safeGross = Math.max(1, grossCurrent);
  const eventSigned =
    events.longNotional -
    events.shortNotional -
    events.closeLongNotional +
    events.closeShortNotional;
  const p25 = weightedQuantile(clusterEntries, 0.25);
  const p75 = weightedQuantile(clusterEntries, 0.75);
  const clusterMid = p25 && p75 ? (p25 + p75) / 2 : 0;
  const clusterCohesion = clusterMid > 0
    ? 1 - clamp(((p75 - p25) / clusterMid) / 0.005, 0, 1)
    : 0;

  const components = {
    qualifiedPositions: component(
      WEIGHTS.qualifiedPositions,
      currentNet / safeGross,
    ),
    netChange15m: component(WEIGHTS.netChange15m, delta15 / safeGross),
    netChange1h: component(WEIGHTS.netChange1h, delta1h / safeGross),
    positionEvents15m: component(
      WEIGHTS.positionEvents15m,
      eventSigned / safeGross,
    ),
    unusualConviction: component(
      WEIGHTS.unusualConviction,
      unusualSigned / safeGross,
    ),
    entryCluster: component(
      WEIGHTS.entryCluster,
      (currentNet / safeGross) * clusterCohesion,
    ),
  };
  const score = round(
    Object.values(components).reduce((sum, item) => sum + item.value, 0),
    1,
  );
  const strength = Math.round(Math.abs(score));
  const conviction = strength >= 65 ? 'HIGH' : strength >= 35 ? 'MEDIUM' : 'LOW';

  return {
    status: 'ready',
    direction: directionForScore(score),
    score,
    strength,
    qualifiedCount: qualified.length,
    newPositions15m: {
      long: events.long,
      short: events.short,
    },
    netPositionChange15m: round(delta15, 2),
    netPositionChange1h: round(delta1h, 2),
    entryCluster: { p25, p75 },
    conviction,
    freshnessMs,
    maturity: round(clamp(maturity, 0, 1), 4),
    components,
    reasons: [
      `${qualified.length} qualified whale positions are aggregated`,
      `${events.short} new SHORT and ${events.long} new LONG positions in 15m`,
      `net position change 1h ${delta1h >= 0 ? '+' : ''}${round(delta1h, 0)}`,
    ],
  };
}
