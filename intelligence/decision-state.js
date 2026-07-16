const EVALUATION_INTERVAL_MS = 15_000;
const EWMA_HALF_LIFE_MS = 45_000;
const MINIMUM_EVIDENCE_MS = 120_000;
const MARKET_PERSISTENCE_MS = 90_000;
const COMBINED_PERSISTENCE_MS = 60_000;
const SWITCH_PERSISTENCE_MS = 120_000;
const EMERGENCY_PERSISTENCE_MS = 30_000;
const SWITCH_COOLDOWN_MS = 10 * 60 * 1_000;
const MATERIAL_DELTA = 0.03;

const clamp = (value, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, Number(value)));

const round = (value, decimals = 8) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const emaAlpha = (elapsedMs) => (
  1 - Math.exp((-Math.log(2) * Math.max(0, elapsedMs)) / EWMA_HALF_LIFE_MS)
);

const oppositeDirection = (direction) => direction === 'long' ? 'short' : 'long';

const stateFor = (direction, prefix) => (
  `${prefix}_${direction.toUpperCase()}`
);

const probabilitiesFor = (direction, candidate) => {
  const probabilities = candidate?.probabilities;
  if (
    !probabilities ||
    ![probabilities.down, probabilities.up, probabilities.neither].every(
      (value) => Number.isFinite(Number(value)) && value >= 0 && value <= 1,
    )
  ) {
    return null;
  }
  const total =
    Number(probabilities.down) +
    Number(probabilities.up) +
    Number(probabilities.neither);
  if (Math.abs(total - 1) > 1e-6) return null;
  return {
    down: Number(probabilities.down),
    up: Number(probabilities.up),
    neither: Number(probabilities.neither),
    target: direction === 'long'
      ? Number(probabilities.down)
      : Number(probabilities.up),
    opposite: direction === 'long'
      ? Number(probabilities.up)
      : Number(probabilities.down),
  };
};

const pathLabels = (direction, probabilities) => ({
  down: {
    probability: probabilities.down,
    label: direction === 'long' ? 'BB TP / FP SL' : 'BB SL / FP TP',
  },
  up: {
    probability: probabilities.up,
    label: direction === 'long' ? 'BB SL / FP TP' : 'BB TP / FP SL',
  },
  neither: {
    probability: probabilities.neither,
    label: 'No barrier inside horizon',
  },
});

const materialChange = (previous, next) => {
  if (!previous) return true;
  if (
    previous.state !== next.state ||
    previous.fpDirection !== next.fpDirection ||
    previous.autoEligible !== next.autoEligible
  ) {
    return true;
  }
  if (!previous.probabilities || !next.probabilities) {
    return previous.probabilities !== next.probabilities;
  }
  return ['down', 'up', 'neither'].some((key) => (
    Math.abs(previous.probabilities[key] - next.probabilities[key]) >= MATERIAL_DELTA
  ));
};

const emptyDecision = (timestamp = null) => ({
  state: 'WARMING',
  fpDirection: null,
  bybitDirection: null,
  autoEligible: false,
  probabilities: null,
  paths: null,
  confidence: 0,
  edge: 0,
  source: 'MARKET_ONLY',
  stableSince: null,
  nextSwitchAllowedAt: null,
  generatedAt: timestamp,
  decisionReferencePrice: null,
  outcomeAnchorPrice: null,
  sentiment: null,
  reasons: ['decision evidence is warming'],
  freshnessMs: null,
});

export function createDecisionStateMachine() {
  const smoothed = new Map();
  let firstEvidenceAt = null;
  let lastEvaluatedAt = null;
  let candidateDirection = null;
  let candidateSince = null;
  let switchCandidate = null;
  let switchCandidateSince = null;
  let emergencyCandidate = null;
  let emergencyCandidateSince = null;
  let activeDirection = null;
  let stableSince = null;
  let nextSwitchAllowedAt = 0;
  let currentState = 'WARMING';
  let transitionReason = null;
  let lastPublishedDecision = null;
  let lockedDecision = null;

  const updateSmoothed = (direction, probabilities, confidence, timestamp) => {
    const previous = smoothed.get(direction);
    if (!previous) {
      const initial = {
        ...probabilities,
        confidence,
        updatedAt: timestamp,
      };
      smoothed.set(direction, initial);
      return initial;
    }
    const alpha = emaAlpha(timestamp - previous.updatedAt);
    const next = {
      down: previous.down + ((probabilities.down - previous.down) * alpha),
      up: previous.up + ((probabilities.up - previous.up) * alpha),
      neither: previous.neither + ((probabilities.neither - previous.neither) * alpha),
      confidence: previous.confidence + ((confidence - previous.confidence) * alpha),
      updatedAt: timestamp,
    };
    next.target = direction === 'long' ? next.down : next.up;
    next.opposite = direction === 'long' ? next.up : next.down;
    smoothed.set(direction, next);
    return next;
  };

  const thresholdsFor = (maturity, walletReady) => !walletReady || maturity < 0.2
    ? {
      target: 0.65,
      margin: 0.18,
      confidence: 0.6,
      persistenceMs: MARKET_PERSISTENCE_MS,
      source: 'MARKET_ONLY',
    }
    : {
      target: 0.6,
      margin: 0.15,
      confidence: 0.55,
      persistenceMs: COMBINED_PERSISTENCE_MS,
      source: 'COMBINED',
    };

  const qualifies = (probabilities, confidence, thresholds) => (
    probabilities.target >= thresholds.target &&
    probabilities.target - probabilities.opposite >= thresholds.margin &&
    confidence >= thresholds.confidence &&
    probabilities.neither < probabilities.target
  );

  const buildDecision = (input, direction, state, source) => {
    const probabilities = direction ? smoothed.get(direction) : null;
    const existingAnchor = (
      lastPublishedDecision?.fpDirection === direction &&
      lastPublishedDecision?.stableSince === stableSince
    )
      ? lastPublishedDecision.outcomeAnchorPrice
      : null;
    const autoEligible = Boolean(
      direction &&
      ['CONFIRMED', 'COOLDOWN', 'LOCKED'].some((prefix) => state.startsWith(prefix)),
    );
    const normalized = probabilities
      ? {
        down: round(probabilities.down, 10),
        up: round(probabilities.up, 10),
        neither: round(probabilities.neither, 10),
      }
      : null;
    return {
      state,
      fpDirection: direction,
      bybitDirection: direction === 'long' ? 'SHORT' : direction === 'short' ? 'LONG' : null,
      autoEligible,
      probabilities: normalized,
      paths: direction && normalized ? pathLabels(direction, normalized) : null,
      confidence: probabilities ? round(probabilities.confidence, 6) : 0,
      edge: probabilities
        ? round(Math.abs(probabilities.target - probabilities.opposite), 6)
        : 0,
      source,
      stableSince,
      nextSwitchAllowedAt: nextSwitchAllowedAt || null,
      generatedAt: input.timestamp,
      decisionReferencePrice:
        Number(input.priceContext?.decisionReferencePrice) || null,
      outcomeAnchorPrice: autoEligible
        ? existingAnchor ?? (Number(input.priceContext?.executionPrice) || null)
        : null,
      sentiment: input.sentiment ?? null,
      reasons: Array.isArray(input.reasons) ? input.reasons.slice(0, 8) : [],
      freshnessMs: 0,
      transitionReason,
    };
  };

  return {
    update(input) {
      if (lockedDecision) return { published: false, decision: lockedDecision };
      if (
        !Number.isSafeInteger(input?.timestamp) ||
        input.timestamp <= 0 ||
        !['long', 'short'].includes(input.recommendation) ||
        !Number.isFinite(Number(input.confidence)) ||
        !Number.isFinite(Number(input.maturity))
      ) {
        throw new Error('Decision state input is invalid.');
      }
      if (
        lastEvaluatedAt !== null &&
        input.timestamp - lastEvaluatedAt < EVALUATION_INTERVAL_MS
      ) {
        return {
          published: false,
          decision: lastPublishedDecision ?? emptyDecision(input.timestamp),
        };
      }
      lastEvaluatedAt = input.timestamp;

      if (input.status === 'stale') {
        currentState = 'STALE';
        const staleDecision = buildDecision(
          input,
          activeDirection,
          currentState,
          Number(input.maturity) >= 0.2 ? 'COMBINED' : 'MARKET_ONLY',
        );
        staleDecision.autoEligible = false;
        if (materialChange(lastPublishedDecision, staleDecision)) {
          lastPublishedDecision = staleDecision;
          return { published: true, decision: staleDecision };
        }
        return { published: false, decision: lastPublishedDecision };
      }

      const longProbabilities = probabilitiesFor('long', input.candidates?.long);
      const shortProbabilities = probabilitiesFor('short', input.candidates?.short);
      if (!longProbabilities || !shortProbabilities || input.status !== 'ready') {
        currentState = 'WARMING';
        const warming = buildDecision(input, activeDirection, currentState, 'MARKET_ONLY');
        warming.autoEligible = false;
        if (materialChange(lastPublishedDecision, warming)) {
          lastPublishedDecision = warming;
          return { published: true, decision: warming };
        }
        return { published: false, decision: lastPublishedDecision };
      }

      firstEvidenceAt ??= input.timestamp;
      updateSmoothed('long', longProbabilities, clamp(input.confidence), input.timestamp);
      updateSmoothed('short', shortProbabilities, clamp(input.confidence), input.timestamp);
      const maturity = clamp(input.maturity);
      const thresholds = thresholdsFor(maturity, input.walletReady === true);
      const recommended = input.recommendation;
      const recommendedProbabilities = smoothed.get(recommended);
      const recommendedQualifies = qualifies(
        recommendedProbabilities,
        recommendedProbabilities.confidence,
        thresholds,
      );
      const evidenceAge = input.timestamp - firstEvidenceAt;

      if (activeDirection === null) {
        if (recommendedQualifies) {
          if (candidateDirection !== recommended) {
            candidateDirection = recommended;
            candidateSince = input.timestamp;
          }
        } else {
          candidateDirection = null;
          candidateSince = null;
        }

        if (
          candidateDirection &&
          evidenceAge >= MINIMUM_EVIDENCE_MS &&
          input.timestamp - candidateSince >= thresholds.persistenceMs
        ) {
          activeDirection = candidateDirection;
          stableSince = input.timestamp;
          nextSwitchAllowedAt = input.timestamp + SWITCH_COOLDOWN_MS;
          currentState = stateFor(activeDirection, 'COOLDOWN');
          transitionReason = 'CONFIRMED';
          candidateDirection = null;
          candidateSince = null;
        } else if (evidenceAge < MINIMUM_EVIDENCE_MS) {
          currentState = 'WARMING';
        } else {
          currentState = stateFor(recommended, 'WATCH');
        }
      } else {
        const opposite = oppositeDirection(activeDirection);
        const oppositeProbabilities = smoothed.get(opposite);
        const oppositeRaw = probabilitiesFor(opposite, input.candidates?.[opposite]);
        const normalSwitchQualifies =
          recommended === opposite &&
          oppositeProbabilities.target - oppositeProbabilities.opposite >= 0.2 &&
          oppositeProbabilities.confidence >= thresholds.confidence &&
          oppositeProbabilities.neither < oppositeProbabilities.target;
        const emergencyQualifies =
          recommended === opposite &&
          oppositeRaw.target >= 0.75 &&
          clamp(input.confidence) >= 0.75 &&
          input.emergencyAligned === true;

        if (normalSwitchQualifies) {
          if (switchCandidate !== opposite) {
            switchCandidate = opposite;
            switchCandidateSince = input.timestamp;
          }
        } else {
          switchCandidate = null;
          switchCandidateSince = null;
        }
        if (emergencyQualifies) {
          if (emergencyCandidate !== opposite) {
            emergencyCandidate = opposite;
            emergencyCandidateSince = input.timestamp;
          }
        } else {
          emergencyCandidate = null;
          emergencyCandidateSince = null;
        }

        const emergencyReady =
          emergencyCandidate === opposite &&
          input.timestamp - emergencyCandidateSince >= EMERGENCY_PERSISTENCE_MS;
        const normalReady =
          switchCandidate === opposite &&
          input.timestamp >= nextSwitchAllowedAt &&
          input.timestamp - switchCandidateSince >= SWITCH_PERSISTENCE_MS;
        if (emergencyReady || normalReady) {
          activeDirection = opposite;
          stableSince = input.timestamp;
          nextSwitchAllowedAt = input.timestamp + SWITCH_COOLDOWN_MS;
          currentState = stateFor(activeDirection, 'COOLDOWN');
          transitionReason = emergencyReady ? 'EMERGENCY' : 'PERSISTED_SWITCH';
          switchCandidate = null;
          switchCandidateSince = null;
          emergencyCandidate = null;
          emergencyCandidateSince = null;
        } else {
          currentState = input.timestamp < nextSwitchAllowedAt
            ? stateFor(activeDirection, 'COOLDOWN')
            : stateFor(activeDirection, 'CONFIRMED');
        }
      }

      const direction = activeDirection ?? recommended;
      const decision = buildDecision(input, direction, currentState, thresholds.source);
      if (materialChange(lastPublishedDecision, decision)) {
        lastPublishedDecision = decision;
        return { published: true, decision };
      }
      return { published: false, decision: lastPublishedDecision };
    },

    lock() {
      if (!lastPublishedDecision?.autoEligible || !lastPublishedDecision.fpDirection) {
        throw new Error('Only a confirmed decision can be locked.');
      }
      lockedDecision = {
        ...lastPublishedDecision,
        state: stateFor(lastPublishedDecision.fpDirection, 'LOCKED'),
        generatedAt: lastPublishedDecision.generatedAt,
      };
      lastPublishedDecision = lockedDecision;
      return lockedDecision;
    },

    unlock(timestamp) {
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
        throw new Error('Unlock timestamp is invalid.');
      }
      smoothed.clear();
      firstEvidenceAt = null;
      lastEvaluatedAt = null;
      candidateDirection = null;
      candidateSince = null;
      switchCandidate = null;
      switchCandidateSince = null;
      emergencyCandidate = null;
      emergencyCandidateSince = null;
      activeDirection = null;
      stableSince = null;
      nextSwitchAllowedAt = 0;
      currentState = 'WARMING';
      transitionReason = null;
      lockedDecision = null;
      lastPublishedDecision = emptyDecision(timestamp);
      return lastPublishedDecision;
    },

    snapshot() {
      return lockedDecision ?? lastPublishedDecision;
    },
  };
}
