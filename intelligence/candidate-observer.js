import {
  classifyWalletBehaviour,
  reconstructTradingEpisodes,
} from './episodes.js';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_REVIEW_INTERVAL_MS = HOUR_MS;
const DEFAULT_FAILURE_RETRY_MS = 15 * 60 * 1_000;
const DEFAULT_LOOKBACK_MS = 90 * DAY_MS;

const coefficientOfVariation = (candidate) => {
  if (
    candidate.intervalCount < 2 ||
    candidate.intervalMeanMs <= 0 ||
    candidate.intervalM2 < 0
  ) {
    return 1;
  }
  const variance = candidate.intervalM2 / (candidate.intervalCount - 1);
  return Math.sqrt(Math.max(0, variance)) / candidate.intervalMeanMs;
};

export function screenCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Candidate is required.');
  }
  if (candidate.seed) {
    return {
      decision: 'observe',
      reason: 'server seed requires independent evaluation',
    };
  }

  const intervalCoefficient = coefficientOfVariation(candidate);
  const switchRatio = candidate.tradeCount > 1
    ? candidate.sideSwitchCount / (candidate.tradeCount - 1)
    : 0;
  const periodicHighFrequency =
    candidate.intervalCount >= 10 &&
    candidate.intervalMeanMs > 0 &&
    candidate.intervalMeanMs < 5_000 &&
    intervalCoefficient < 0.12;
  if (periodicHighFrequency && switchRatio > 0.35) {
    return {
      decision: 'exclude',
      reason: 'periodic high-frequency two-sided activity',
    };
  }

  if (
    candidate.tradeCount >= 3 &&
    (candidate.notional >= 2_000 || candidate.maxNotional >= 500)
  ) {
    return {
      decision: 'observe',
      reason: 'gold activity passed cheap candidate threshold',
    };
  }

  return {
    decision: 'wait',
    reason: 'insufficient directional gold evidence',
  };
}

export function createCandidateObserver({
  database,
  infoClient,
  now = Date.now,
  logger = () => {},
  maxCandidates = 12,
  reviewIntervalMs = DEFAULT_REVIEW_INTERVAL_MS,
  failureRetryMs = DEFAULT_FAILURE_RETRY_MS,
  lookbackMs = DEFAULT_LOOKBACK_MS,
} = {}) {
  if (
    !database?.listCandidates ||
    !database?.setWalletReview ||
    !infoClient?.fetchUserGoldFills ||
    !infoClient?.fetchGoldPosition
  ) {
    throw new Error('Candidate observer dependencies are incomplete.');
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
    throw new Error('maxCandidates must be between 1 and 100.');
  }
  for (const [name, value] of Object.entries({
    reviewIntervalMs,
    failureRetryMs,
    lookbackMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 60_000) {
      throw new Error(`${name} must be at least one minute.`);
    }
  }

  let running = false;

  const transitionIfNeeded = (address, currentStatus, toStatus, details) => {
    if (currentStatus === toStatus) return database.getWallet(address);
    return database.transitionWallet(address, toStatus, details);
  };

  return {
    async runOnce() {
      if (running) {
        return {
          reviewed: 0,
          qualified: 0,
          excluded: 0,
          waiting: 0,
          failed: 0,
        };
      }
      running = true;
      const at = now();
      const result = {
        reviewed: 0,
        qualified: 0,
        excluded: 0,
        waiting: 0,
        failed: 0,
      };

      try {
        const candidates = database.listCandidates({
          statuses: ['DISCOVERED', 'OBSERVED', 'RETIRED'],
          reviewBefore: at,
          limit: maxCandidates,
        });

        for (const candidate of candidates) {
          result.reviewed += 1;
          const screen = screenCandidate(candidate);
          if (screen.decision === 'wait') {
            database.setWalletReview(candidate.address, at + reviewIntervalMs, { at });
            result.waiting += 1;
            continue;
          }
          if (screen.decision === 'exclude') {
            transitionIfNeeded(candidate.address, candidate.status, 'EXCLUDED', {
              reason: screen.reason,
              exclusionReason: screen.reason,
              at,
            });
            result.excluded += 1;
            continue;
          }

          try {
            let current = candidate;
            if (['DISCOVERED', 'RETIRED'].includes(current.status)) {
              current = database.transitionWallet(current.address, 'OBSERVED', {
                reason: screen.reason,
                at,
              });
            }
            const fills = await infoClient.fetchUserGoldFills(current.address, {
              startTime: Math.max(1, at - lookbackMs),
              endTime: at,
            });
            database.recordFills(current.address, fills);
            const storedFills = database.listFills(current.address);
            const firstTimestamp = storedFills[0]?.timestamp ?? at;
            const marketSamples = database.listMarketSamples({
              from: firstTimestamp,
              to: at,
            });
            const episodes = reconstructTradingEpisodes(storedFills, { marketSamples });
            database.replaceEpisodes(current.address, episodes);
            const classification = classifyWalletBehaviour(episodes, storedFills);
            const position = await infoClient.fetchGoldPosition(current.address);
            database.recordGoldPosition(current.address, position, { at });

            if (classification.excluded) {
              database.transitionWallet(current.address, 'EXCLUDED', {
                reason: classification.reasons.join(', ').slice(0, 240),
                exclusionReason: classification.labels.join(', ').slice(0, 240),
                at,
              });
              result.excluded += 1;
            } else if (classification.metrics.completeEpisodeCount >= 3) {
              database.transitionWallet(current.address, 'QUALIFIED', {
                reason: 'minimum complete intraday episode evidence reached',
                score: Math.min(1, classification.metrics.completeEpisodeCount / 20),
                at,
              });
              result.qualified += 1;
            } else {
              result.waiting += 1;
            }
            database.setWalletReview(current.address, at + reviewIntervalMs, { at });
          } catch (error) {
            database.setWalletReview(candidate.address, at + failureRetryMs, { at });
            logger({
              event: 'candidate_observation_failed',
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

