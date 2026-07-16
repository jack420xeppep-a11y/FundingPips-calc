const SECOND_MS = 1_000;
const NORMAL_HALF_LIFE_MS = 45_000;
const FAST_HALF_LIFE_MS = 10_000;
const FAST_ENTER_DEVIATION = 0.0012;
const FAST_EXIT_DEVIATION = 0.0005;
const FAST_PERSISTENCE_MS = 10_000;
const MAX_SAMPLES = 5;

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const median = (values) => {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
};

const emaAlpha = (elapsedMs, halfLifeMs) => (
  1 - Math.exp((-Math.log(2) * Math.max(0, elapsedMs)) / halfLifeMs)
);

export function createDecisionPriceTracker({
  now = Date.now,
  normalHalfLifeMs = NORMAL_HALF_LIFE_MS,
  fastHalfLifeMs = FAST_HALF_LIFE_MS,
} = {}) {
  if (
    typeof now !== 'function' ||
    !Number.isSafeInteger(normalHalfLifeMs) ||
    normalHalfLifeMs < SECOND_MS ||
    !Number.isSafeInteger(fastHalfLifeMs) ||
    fastHalfLifeMs < SECOND_MS ||
    fastHalfLifeMs > normalHalfLifeMs
  ) {
    throw new Error('Decision price tracker configuration is invalid.');
  }

  const samples = [];
  let executionPrice = null;
  let executionTimestamp = null;
  let decisionReferencePrice = null;
  let referenceTimestamp = null;
  let sampledSecond = null;
  let divergenceStartedAt = null;
  let mode = 'NORMAL';

  const snapshot = () => {
    const deviationPct = isPositive(executionPrice) && isPositive(decisionReferencePrice)
      ? (Math.abs(executionPrice - decisionReferencePrice) / executionPrice) * 100
      : null;
    return {
      executionPrice,
      decisionReferencePrice,
      executionTimestamp,
      referenceTimestamp,
      deviationPct,
      mode,
      sampleCount: samples.length,
    };
  };

  return {
    update({ price, timestamp = now() } = {}) {
      if (!isPositive(price) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
        throw new Error('Decision price update is invalid.');
      }
      executionPrice = Number(price);
      executionTimestamp = timestamp;
      const second = Math.floor(timestamp / SECOND_MS);
      if (second === sampledSecond) return snapshot();
      sampledSecond = second;
      samples.push({ price: executionPrice, timestamp });
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);

      if (decisionReferencePrice === null) {
        decisionReferencePrice = executionPrice;
        referenceTimestamp = timestamp;
        return snapshot();
      }

      const currentDeviation = Math.abs(
        (executionPrice - decisionReferencePrice) / executionPrice,
      );
      if (currentDeviation > FAST_ENTER_DEVIATION) {
        divergenceStartedAt ??= timestamp;
        if (timestamp - divergenceStartedAt >= FAST_PERSISTENCE_MS) mode = 'FAST';
      } else if (currentDeviation < FAST_EXIT_DEVIATION) {
        divergenceStartedAt = null;
        mode = 'NORMAL';
      }

      const target = median(samples.map((sample) => sample.price));
      const elapsedMs = Math.max(1, timestamp - referenceTimestamp);
      const halfLifeMs = mode === 'FAST' ? fastHalfLifeMs : normalHalfLifeMs;
      decisionReferencePrice += (
        target - decisionReferencePrice
      ) * emaAlpha(elapsedMs, halfLifeMs);
      referenceTimestamp = timestamp;
      return snapshot();
    },

    snapshot,
  };
}
