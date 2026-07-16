const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const EPSILON = 1e-12;

const round = (value, decimals = 8) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const sign = (value) => {
  const numeric = Number(value);
  if (numeric > EPSILON) return 1;
  if (numeric < -EPSILON) return -1;
  return 0;
};

const median = (values) => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
};

const sessionForTimestamp = (timestamp) => {
  const hour = new Date(timestamp).getUTCHours();
  if (hour < 7) return 'ASIA';
  if (hour < 13) return 'LONDON';
  if (hour < 21) return 'NEW_YORK';
  return 'OFF_HOURS';
};

const targetBand = (movementBps) => {
  const movement = Math.abs(Number(movementBps) || 0);
  if (movement < 20) return '0-0.20%';
  if (movement < 35) return '0.20-0.35%';
  if (movement < 60) return '0.35-0.60%';
  if (movement < 100) return '0.60-1.00%';
  return '1.00%+';
};

const nearestRegime = (samples, timestamp) => {
  let selected = null;
  for (const sample of samples) {
    if (!sample?.regime) continue;
    if (sample.timestamp <= timestamp) selected = sample.regime;
    else if (!selected) selected = sample.regime;
    else break;
  }
  return selected ?? 'UNKNOWN';
};

const createEpisode = ({
  fill,
  side,
  size,
  historyTruncated,
}) => ({
  address: fill.address,
  side,
  openedAt: fill.timestamp,
  closedAt: null,
  entryPrice: fill.price,
  exitPrice: null,
  peakSize: size,
  currentSize: size,
  closedSize: 0,
  exitNotional: 0,
  closedPnl: 0,
  fillCount: 0,
  aggressiveCount: 0,
  holdMs: null,
  mfeBps: null,
  maeBps: null,
  capturedBps: null,
  complete: false,
  historyTruncated,
  session: sessionForTimestamp(fill.timestamp),
  regime: 'UNKNOWN',
  targetBand: '0-0.20%',
});

const registerFill = (episode, fill) => {
  episode.fillCount += 1;
  if (fill.crossed) episode.aggressiveCount += 1;
};

const finalizeEpisode = (episode, {
  closedAt,
  complete,
  marketSamples,
}) => {
  episode.closedAt = closedAt;
  episode.complete = complete && !episode.historyTruncated;
  episode.exitPrice = episode.closedSize > EPSILON
    ? round(episode.exitNotional / episode.closedSize)
    : null;
  episode.holdMs = closedAt === null ? null : Math.max(0, closedAt - episode.openedAt);
  episode.aggressiveRatio = episode.fillCount > 0
    ? round(episode.aggressiveCount / episode.fillCount, 6)
    : 0;

  if (episode.exitPrice !== null) {
    const direction = episode.side === 'LONG' ? 1 : -1;
    episode.capturedBps = round(
      direction * ((episode.exitPrice / episode.entryPrice) - 1) * 10_000,
      4,
    );
  }

  const end = closedAt ?? Number.MAX_SAFE_INTEGER;
  const path = marketSamples.filter((sample) => (
    Number.isFinite(sample?.timestamp) &&
    Number.isFinite(sample?.price) &&
    sample.price > 0 &&
    sample.timestamp >= episode.openedAt &&
    sample.timestamp <= end
  ));
  if (path.length > 0) {
    const prices = path.map(({ price }) => Number(price));
    const highest = Math.max(...prices);
    const lowest = Math.min(...prices);
    if (episode.side === 'LONG') {
      episode.mfeBps = round(((highest / episode.entryPrice) - 1) * 10_000, 4);
      episode.maeBps = round(((lowest / episode.entryPrice) - 1) * 10_000, 4);
    } else {
      episode.mfeBps = round((1 - (lowest / episode.entryPrice)) * 10_000, 4);
      episode.maeBps = round((1 - (highest / episode.entryPrice)) * 10_000, 4);
    }
  }

  episode.regime = nearestRegime(marketSamples, episode.openedAt);
  episode.targetBand = targetBand(Math.max(
    Math.abs(episode.capturedBps ?? 0),
    Math.abs(episode.mfeBps ?? 0),
  ));

  delete episode.currentSize;
  delete episode.closedSize;
  delete episode.exitNotional;
  delete episode.aggressiveCount;
  return episode;
};

export function reconstructTradingEpisodes(fills, { marketSamples = [] } = {}) {
  if (!Array.isArray(fills) || !Array.isArray(marketSamples)) {
    throw new Error('Fills and market samples must be arrays.');
  }
  const ordered = [...fills].sort((left, right) => (
    left.timestamp - right.timestamp || left.tid - right.tid
  ));
  const samples = [...marketSamples].sort((left, right) => left.timestamp - right.timestamp);
  const episodes = [];
  let active = null;

  const closeActive = (timestamp, complete) => {
    if (!active) return;
    episodes.push(finalizeEpisode(active, {
      closedAt: timestamp,
      complete,
      marketSamples: samples,
    }));
    active = null;
  };

  for (const fill of ordered) {
    const delta = fill.side === 'B' ? fill.size : -fill.size;
    const startPosition = Number(fill.startPosition);
    const endPosition = round(startPosition + delta, 12);
    const startSign = sign(startPosition);
    const endSign = sign(endPosition);

    if (
      fill?.coin !== 'xyz:GOLD' ||
      !['A', 'B'].includes(fill.side) ||
      !Number.isFinite(fill.size) ||
      fill.size <= 0 ||
      !Number.isFinite(startPosition) ||
      !Number.isFinite(fill.price) ||
      fill.price <= 0
    ) {
      throw new Error('Invalid normalized fill.');
    }

    if (active && startSign !== 0) {
      const activeSign = active.side === 'LONG' ? 1 : -1;
      if (activeSign !== startSign) closeActive(fill.timestamp, false);
    }

    if (!active && startSign !== 0) {
      active = createEpisode({
        fill,
        side: startSign > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(startPosition),
        historyTruncated: true,
      });
    }

    if (startSign === 0 && endSign !== 0) {
      if (active) closeActive(fill.timestamp, false);
      active = createEpisode({
        fill,
        side: endSign > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(endPosition),
        historyTruncated: false,
      });
      registerFill(active, fill);
      continue;
    }

    if (!active || startSign === 0) continue;
    registerFill(active, fill);

    if (endSign === startSign) {
      const startSize = Math.abs(startPosition);
      const endSize = Math.abs(endPosition);
      if (endSize > startSize + EPSILON) {
        const addedSize = endSize - startSize;
        active.entryPrice = round(
          ((active.entryPrice * startSize) + (fill.price * addedSize)) / endSize,
        );
      } else if (endSize < startSize - EPSILON) {
        const reducedSize = startSize - endSize;
        active.closedSize += reducedSize;
        active.exitNotional += fill.price * reducedSize;
        active.closedPnl += Number(fill.closedPnl);
      }
      active.currentSize = endSize;
      active.peakSize = Math.max(active.peakSize, endSize);
      continue;
    }

    const closedSize = Math.abs(startPosition);
    active.closedSize += closedSize;
    active.exitNotional += fill.price * closedSize;
    active.closedPnl += Number(fill.closedPnl);
    active.currentSize = 0;
    closeActive(fill.timestamp, true);

    if (endSign !== 0) {
      active = createEpisode({
        fill,
        side: endSign > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(endPosition),
        historyTruncated: false,
      });
      registerFill(active, fill);
    }
  }

  if (active) {
    episodes.push(finalizeEpisode(active, {
      closedAt: null,
      complete: false,
      marketSamples: samples,
    }));
  }

  return episodes.map((episode) => ({
    ...episode,
    peakSize: round(episode.peakSize),
    closedPnl: round(episode.closedPnl),
  }));
}

export function classifyWalletBehaviour(episodes, fills) {
  if (!Array.isArray(episodes) || !Array.isArray(fills)) {
    throw new Error('Episodes and fills must be arrays.');
  }
  const complete = episodes.filter((episode) => (
    episode.complete && Number.isFinite(episode.holdMs)
  ));
  const holds = complete.map(({ holdMs }) => holdMs);
  const medianHoldMs = median(holds);
  const sortedFills = [...fills].sort((left, right) => left.timestamp - right.timestamp);
  const spanHours = sortedFills.length > 1
    ? Math.max((sortedFills.at(-1).timestamp - sortedFills[0].timestamp) / HOUR_MS, 1 / 60)
    : 1;
  const fillsPerHour = sortedFills.length / spanHours;
  const passiveRatio = sortedFills.length > 0
    ? sortedFills.filter((fill) => !fill.crossed).length / sortedFills.length
    : 0;
  let sideSwitches = 0;
  for (let index = 1; index < complete.length; index += 1) {
    if (complete[index].side !== complete[index - 1].side) sideSwitches += 1;
  }
  const reversalRatio = complete.length > 1 ? sideSwitches / (complete.length - 1) : 0;
  const longCount = complete.filter(({ side }) => side === 'LONG').length;
  const shortCount = complete.filter(({ side }) => side === 'SHORT').length;
  const bothSidesRatio = complete.length > 0
    ? Math.min(longCount, shortCount) / complete.length
    : 0;
  const averageCapturedBps = complete.length > 0
    ? complete.reduce((sum, episode) => sum + Math.abs(episode.capturedBps ?? 0), 0) /
      complete.length
    : 0;
  const intervals = [];
  for (let index = 1; index < sortedFills.length; index += 1) {
    const interval = sortedFills[index].timestamp - sortedFills[index - 1].timestamp;
    if (interval > 0) intervals.push(interval);
  }
  const intervalMean = intervals.length > 0
    ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
    : 0;
  const intervalVariance = intervals.length > 1
    ? intervals.reduce((sum, value) => sum + ((value - intervalMean) ** 2), 0) /
      (intervals.length - 1)
    : 0;
  const intervalCoefficient = intervalMean > 0
    ? Math.sqrt(intervalVariance) / intervalMean
    : 1;

  const signals = {
    shortHolding: complete.length >= 3 && medianHoldMs < 10 * MINUTE_MS,
    highFrequency: fillsPerHour > 30,
    frequentReversals: complete.length >= 5 && reversalRatio > 0.35,
    bothSides: complete.length >= 5 && bothSidesRatio > 0.3,
    smallMovement: complete.length >= 3 && averageCapturedBps < 10,
    mostlyPassive: sortedFills.length >= 10 && passiveRatio > 0.75,
    periodicBot: intervals.length >= 10 && intervalCoefficient < 0.12,
  };
  const reasons = Object.entries(signals).flatMap(([signal, active]) => (
    active ? [signal] : []
  ));
  const marketMakerLike =
    signals.highFrequency && signals.mostlyPassive && signals.bothSides;
  const botLike = signals.periodicBot && (signals.highFrequency || signals.shortHolding);
  const suspiciousCount = reasons.length;
  const excluded = marketMakerLike || botLike || (
    suspiciousCount >= 3 && (signals.highFrequency || signals.shortHolding)
  );
  const labels = [];
  if (
    complete.length >= 3 &&
    medianHoldMs >= 15 * MINUTE_MS &&
    medianHoldMs <= 4 * HOUR_MS &&
    !excluded
  ) {
    labels.push('INTRADAY_DIRECTIONAL');
  }
  if (signals.shortHolding) labels.push('SCALPER_LIKE');
  if (marketMakerLike) labels.push('MARKET_MAKER_LIKE');
  if (botLike) labels.push('BOT_LIKE');

  return {
    excluded,
    labels,
    reasons,
    metrics: {
      completeEpisodeCount: complete.length,
      medianHoldMs: round(medianHoldMs, 2),
      fillsPerHour: round(fillsPerHour, 4),
      reversalRatio: round(reversalRatio, 6),
      bothSidesRatio: round(bothSidesRatio, 6),
      passiveRatio: round(passiveRatio, 6),
      averageCapturedBps: round(averageCapturedBps, 4),
      intervalCoefficient: round(intervalCoefficient, 6),
    },
  };
}
