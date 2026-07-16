const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const MINUTE_MS = 60 * 1_000;
const EWMA_HALF_LIFE_MS = 30 * DAY_MS;
const PROBATION_MIN_MS = 24 * HOUR_MS;

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number(value)));

const round = (value, decimals = 8) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const median = (values) => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
};

const wilsonLowerBound = (wins, total, z = 1.96) => {
  if (total < 1) return 0;
  const probability = wins / total;
  const zSquared = z ** 2;
  const denominator = 1 + (zSquared / total);
  const centre = probability + (zSquared / (2 * total));
  const margin = z * Math.sqrt(
    ((probability * (1 - probability)) / total) +
    (zSquared / (4 * (total ** 2))),
  );
  return clamp((centre - margin) / denominator);
};

const calculateSharpe = (returns) => {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce(
    (sum, value) => sum + ((value - mean) ** 2),
    0,
  ) / (returns.length - 1);
  const deviation = Math.sqrt(Math.max(0, variance));
  if (deviation === 0) return mean > 0 ? 5 : mean < 0 ? -5 : 0;
  return clamp((mean / deviation) * Math.sqrt(returns.length), -5, 5);
};

const sideQuality = (episodes, side) => {
  const selected = episodes.filter((episode) => episode.side === side);
  if (selected.length === 0) return 0;
  const wins = selected.filter(({ closedPnl }) => closedPnl > 0).length;
  const grossProfit = selected.reduce(
    (sum, episode) => sum + Math.max(0, episode.closedPnl),
    0,
  );
  const grossLoss = selected.reduce(
    (sum, episode) => sum + Math.abs(Math.min(0, episode.closedPnl)),
    0,
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0;
  const sampleConfidence = clamp(Math.sqrt(selected.length / 12));
  return clamp((
    (wilsonLowerBound(wins, selected.length) * 0.55) +
    ((profitFactor / (profitFactor + 1)) * 0.45)
  ) * sampleConfidence);
};

export function scoreWalletEpisodes(episodes, { now = Date.now() } = {}) {
  if (!Array.isArray(episodes) || !Number.isSafeInteger(now) || now <= 0) {
    throw new Error('Valid episodes and timestamp are required.');
  }
  const complete = episodes.filter((episode) => (
    episode?.complete &&
    Number.isFinite(episode.closedPnl) &&
    Number.isFinite(episode.entryPrice) &&
    episode.entryPrice > 0 &&
    Number.isFinite(episode.peakSize) &&
    episode.peakSize > 0 &&
    Number.isSafeInteger(episode.closedAt)
  ));
  const episodeCount = complete.length;
  if (episodeCount === 0) {
    return {
      calculatedAt: now,
      episodeCount: 0,
      winRate: 0,
      wilsonLower: 0,
      profitFactor: 0,
      sharpe: 0,
      ewmaQuality: 0,
      antiLuck: 0,
      longQuality: 0,
      shortQuality: 0,
      overallScore: 0,
    };
  }

  const wins = complete.filter(({ closedPnl }) => closedPnl > 0).length;
  const grossProfit = complete.reduce(
    (sum, episode) => sum + Math.max(0, episode.closedPnl),
    0,
  );
  const grossLoss = complete.reduce(
    (sum, episode) => sum + Math.abs(Math.min(0, episode.closedPnl)),
    0,
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0;
  const returns = complete.map((episode) => (
    episode.closedPnl / (episode.entryPrice * episode.peakSize)
  ));
  const sharpe = calculateSharpe(returns);
  let weightedQuality = 0;
  let recencyWeight = 0;
  for (const episode of complete) {
    const age = Math.max(0, now - episode.closedAt);
    const weight = Math.exp((-Math.log(2) * age) / EWMA_HALF_LIFE_MS);
    const outcomeQuality = episode.closedPnl > 0
      ? clamp(0.55 + (Math.max(0, episode.capturedBps ?? 0) / 200))
      : clamp(0.45 + (Math.min(0, episode.capturedBps ?? 0) / 200));
    weightedQuality += outcomeQuality * weight;
    recencyWeight += weight;
  }
  const ewmaQuality = recencyWeight > 0 ? weightedQuality / recencyWeight : 0;
  const totalAbsolutePnl = complete.reduce(
    (sum, episode) => sum + Math.abs(episode.closedPnl),
    0,
  );
  const largestOutcome = complete.reduce(
    (maximum, episode) => Math.max(maximum, Math.abs(episode.closedPnl)),
    0,
  );
  const concentration = totalAbsolutePnl > 0 ? largestOutcome / totalAbsolutePnl : 1;
  const antiLuck = clamp(
    Math.sqrt(episodeCount / 20) * (1 - (0.75 * concentration)),
  );
  const winRate = wins / episodeCount;
  const wilsonLower = wilsonLowerBound(wins, episodeCount);
  const profitFactorScore = profitFactor / (profitFactor + 1);
  const sharpeScore = clamp((sharpe + 2) / 4);
  const overallScore = clamp(
    (wilsonLower * 0.25) +
    (profitFactorScore * 0.2) +
    (sharpeScore * 0.15) +
    (ewmaQuality * 0.2) +
    (antiLuck * 0.2),
  );

  return {
    calculatedAt: now,
    episodeCount,
    winRate: round(winRate, 6),
    wilsonLower: round(wilsonLower, 6),
    profitFactor: round(profitFactor, 6),
    sharpe: round(sharpe, 6),
    ewmaQuality: round(ewmaQuality, 6),
    antiLuck: round(antiLuck, 6),
    longQuality: round(sideQuality(complete, 'LONG'), 6),
    shortQuality: round(sideQuality(complete, 'SHORT'), 6),
    overallScore: round(overallScore, 6),
  };
}

const groupQuality = (episodes) => {
  if (episodes.length === 0) return 0;
  const wins = episodes.filter(({ closedPnl }) => closedPnl > 0).length;
  const pnl = episodes.reduce((sum, episode) => sum + episode.closedPnl, 0);
  const pnlQuality = clamp(0.5 + (pnl / (
    episodes.reduce((sum, episode) => sum + Math.abs(episode.closedPnl), 0) || 1
  )) / 2);
  return clamp((wilsonLowerBound(wins, episodes.length) * 0.6) + (pnlQuality * 0.4));
};

const addGroupedMemberships = (memberships, episodes, {
  field,
  prefix,
  minimum = 3,
  transform = (value) => value,
}) => {
  const groups = new Map();
  for (const episode of episodes) {
    const key = episode[field];
    if (!key || key === 'UNKNOWN') continue;
    const selected = groups.get(key) ?? [];
    selected.push(episode);
    groups.set(key, selected);
  }
  for (const [key, selected] of groups) {
    const score = groupQuality(selected);
    if (selected.length < minimum || score < 0.42) continue;
    memberships.push({
      cohort: `${prefix}_${transform(key)}`,
      score: round(score, 6),
      reason: `${selected.length} verified episodes matched ${field}`,
    });
  }
};

const normalizeCohortToken = (value) => String(value)
  .toUpperCase()
  .replaceAll('%', '')
  .replaceAll('.', '_')
  .replaceAll('-', '_')
  .replaceAll(/[^A-Z0-9_]/g, '_')
  .replaceAll(/_+/g, '_')
  .replace(/^_|_$/g, '');

export function buildCohortMemberships({
  episodes,
  score,
  currentPosition = null,
}) {
  if (!Array.isArray(episodes) || !score) {
    throw new Error('Episodes and score are required.');
  }
  const complete = episodes.filter(({ complete }) => complete);
  const memberships = [];
  const holdMedian = median(complete.map(({ holdMs }) => holdMs).filter(Number.isFinite));
  if (
    complete.length >= 3 &&
    holdMedian >= 15 * MINUTE_MS &&
    holdMedian <= 4 * HOUR_MS
  ) {
    memberships.push({
      cohort: 'INTRADAY_DIRECTIONAL',
      score: score.overallScore,
      reason: 'median holding time is inside the 15m-4h intraday horizon',
    });
  }

  const longCount = complete.filter(({ side }) => side === 'LONG').length;
  const shortCount = complete.filter(({ side }) => side === 'SHORT').length;
  if (longCount >= 3 && score.longQuality >= 0.42) {
    memberships.push({
      cohort: 'SIDE_LONG',
      score: score.longQuality,
      reason: `${longCount} complete LONG episodes passed side threshold`,
    });
  }
  if (shortCount >= 3 && score.shortQuality >= 0.42) {
    memberships.push({
      cohort: 'SIDE_SHORT',
      score: score.shortQuality,
      reason: `${shortCount} complete SHORT episodes passed side threshold`,
    });
  }

  addGroupedMemberships(memberships, complete, {
    field: 'session',
    prefix: 'SESSION',
  });
  addGroupedMemberships(memberships, complete, {
    field: 'regime',
    prefix: 'REGIME',
  });
  addGroupedMemberships(memberships, complete, {
    field: 'targetBand',
    prefix: 'TARGET',
    transform: normalizeCohortToken,
  });

  if (currentPosition && ['LONG', 'SHORT'].includes(currentPosition.side)) {
    const historicNotionals = complete.map(
      (episode) => episode.entryPrice * episode.peakSize,
    );
    const reference = Math.max(25_000, median(historicNotionals) * 2);
    if (currentPosition.positionValue >= reference) {
      memberships.push({
        cohort: `WHALE_CONVICTION_${currentPosition.side}`,
        score: clamp(
          score.overallScore * Math.min(1.2, currentPosition.positionValue / reference),
        ),
        reason: 'current gold position is unusually large versus verified history',
      });
    }
  }

  const unique = new Map();
  for (const membership of memberships) {
    if (!unique.has(membership.cohort) || unique.get(membership.cohort).score < membership.score) {
      unique.set(membership.cohort, membership);
    }
  }
  return [...unique.values()].sort((left, right) => left.cohort.localeCompare(right.cohort));
}

export function decideWalletLifecycle({
  wallet,
  score,
  membershipCount,
  now = Date.now(),
}) {
  if (!wallet || !score || !Number.isInteger(membershipCount)) {
    throw new Error('Lifecycle evidence is incomplete.');
  }
  const age = Math.max(0, now - Number(wallet.updatedAt ?? now));

  if (
    wallet.status === 'QUALIFIED' &&
    score.episodeCount >= 8 &&
    score.overallScore >= 0.55 &&
    membershipCount >= 2
  ) {
    return {
      nextStatus: 'ACTIVE_COHORT',
      reason: 'qualified evidence passed active cohort threshold',
    };
  }
  if (
    wallet.status === 'QUALIFIED' &&
    score.episodeCount >= 8 &&
    score.overallScore < 0.3
  ) {
    return {
      nextStatus: 'PROBATION',
      reason: 'qualified score failed sustained quality threshold',
    };
  }
  if (wallet.status === 'ACTIVE_COHORT' && score.overallScore < 0.45) {
    return {
      nextStatus: 'PROBATION',
      reason: 'active score fell below probation threshold',
    };
  }
  if (
    wallet.status === 'PROBATION' &&
    score.overallScore >= 0.58 &&
    membershipCount >= 2
  ) {
    return {
      nextStatus: 'ACTIVE_COHORT',
      reason: 'probation score recovered above activation hysteresis',
    };
  }
  if (
    wallet.status === 'PROBATION' &&
    score.overallScore < 0.35 &&
    age >= PROBATION_MIN_MS
  ) {
    return {
      nextStatus: 'RETIRED',
      reason: 'probation remained below retirement threshold for 24h',
    };
  }
  return {
    nextStatus: wallet.status,
    reason: 'lifecycle hysteresis retained current status',
  };
}

export function createCohortRotator({
  database,
  now = Date.now,
  logger = () => {},
  maxWallets = 1_000,
} = {}) {
  if (
    !database?.listCandidates ||
    !database?.listEpisodes ||
    !database?.saveWalletScore ||
    !database?.replaceCohortMemberships
  ) {
    throw new Error('Cohort rotator dependencies are incomplete.');
  }
  if (!Number.isInteger(maxWallets) || maxWallets < 1 || maxWallets > 5_000) {
    throw new Error('maxWallets must be between 1 and 5000.');
  }

  let running = false;

  return {
    async runOnce() {
      if (running) {
        return {
          reviewed: 0,
          activated: 0,
          probation: 0,
          retired: 0,
          unchanged: 0,
          failed: 0,
        };
      }
      running = true;
      const at = now();
      const result = {
        reviewed: 0,
        activated: 0,
        probation: 0,
        retired: 0,
        unchanged: 0,
        failed: 0,
      };

      try {
        const wallets = database.listCandidates({
          statuses: ['QUALIFIED', 'ACTIVE_COHORT', 'PROBATION'],
          reviewBefore: Number.MAX_SAFE_INTEGER,
          limit: maxWallets,
        });
        for (const wallet of wallets) {
          result.reviewed += 1;
          try {
            const episodes = database.listEpisodes(wallet.address, { completeOnly: true });
            const score = scoreWalletEpisodes(episodes, { now: at });
            const memberships = buildCohortMemberships({
              episodes,
              score,
              currentPosition: wallet.positionSide ? {
                side: wallet.positionSide,
                positionValue: wallet.positionValue,
              } : null,
            });
            database.saveWalletScore(wallet.address, score);
            database.replaceCohortMemberships(wallet.address, memberships, { at });
            const decision = decideWalletLifecycle({
              wallet,
              score,
              membershipCount: memberships.length,
              now: at,
            });
            if (decision.nextStatus === wallet.status) {
              result.unchanged += 1;
              continue;
            }
            database.transitionWallet(wallet.address, decision.nextStatus, {
              reason: decision.reason,
              score: score.overallScore,
              at,
            });
            if (decision.nextStatus === 'ACTIVE_COHORT') result.activated += 1;
            else if (decision.nextStatus === 'PROBATION') result.probation += 1;
            else if (decision.nextStatus === 'RETIRED') result.retired += 1;
          } catch (error) {
            logger({
              event: 'cohort_rotation_failed',
              errorType: error?.name ?? 'Error',
              timestamp: at,
            });
            result.failed += 1;
          }
        }
      } finally {
        running = false;
      }
      return result;
    },
  };
}

