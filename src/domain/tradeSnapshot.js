import { buildTradeTicket } from './tradeTicket.js';

export const TRADE_SNAPSHOT_STORAGE_KEY = 'calcpro-trade-snapshot-v1';
const SNAPSHOT_VERSION = 1;
const MAX_HORIZON_MS = 24 * 60 * 60 * 1_000;

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const clone = (value) => JSON.parse(JSON.stringify(value));

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

const formatProbability = (value) => `${Math.round(Number(value) * 100)}%`;

const buildSnapshotTicket = (position, instrument, decision) => [
  buildTradeTicket(position, instrument),
  '',
  `HL DECISION · FP ${decision.fpDirection.toUpperCase()} / BYBIT ${decision.bybitDirection}`,
  `DOWN: ${formatProbability(decision.probabilities.down)} · ${decision.paths?.down?.label ?? ''}`,
  `UP: ${formatProbability(decision.probabilities.up)} · ${decision.paths?.up?.label ?? ''}`,
  `NEITHER: ${formatProbability(decision.probabilities.neither)}`,
  `CONFIDENCE: ${formatProbability(decision.confidence)} · ${decision.source}`,
].join('\n');

const validLeg = (leg) => (
  leg &&
  ['LONG', 'SHORT'].includes(leg.direction) &&
  isPositive(leg.lots) &&
  isPositive(leg.takeProfit) &&
  isPositive(leg.stopLoss)
);

const validDecision = (decision) => {
  if (
    !decision ||
    decision.autoEligible !== true ||
    !['long', 'short'].includes(decision.fpDirection) ||
    !['LONG', 'SHORT'].includes(decision.bybitDirection) ||
    !decision.probabilities ||
    ![decision.probabilities.down, decision.probabilities.up, decision.probabilities.neither]
      .every((value) => Number.isFinite(Number(value)) && value >= 0 && value <= 1) ||
    !Number.isFinite(Number(decision.confidence)) ||
    !isPositive(decision.outcomeAnchorPrice) ||
    !decision.paths?.down ||
    !decision.paths?.up ||
    !decision.paths?.neither
  ) {
    return false;
  }
  const total =
    Number(decision.probabilities.down) +
    Number(decision.probabilities.up) +
    Number(decision.probabilities.neither);
  return Math.abs(total - 1) <= 1e-6;
};

const validSnapshot = (snapshot) => (
  snapshot &&
  snapshot.version === SNAPSHOT_VERSION &&
  typeof snapshot.id === 'string' &&
  snapshot.id.length >= 3 &&
  Number.isSafeInteger(snapshot.createdAt) &&
  Number.isSafeInteger(snapshot.expiresAt) &&
  snapshot.expiresAt > snapshot.createdAt &&
  snapshot.expiresAt - snapshot.createdAt <= MAX_HORIZON_MS &&
  typeof snapshot.instrument === 'string' &&
  isPositive(snapshot.entryPrice) &&
  snapshot.values &&
  snapshot.values.instrument === snapshot.instrument &&
  Number(snapshot.values.entryPrice) === Number(snapshot.entryPrice) &&
  ['long', 'short'].includes(snapshot.values.fpDirection) &&
  isPositive(snapshot.values.slPct) &&
  ['p1', 'p2', 'funded'].includes(snapshot.values.stage) &&
  isPositive(snapshot.values.rrRatio) &&
  snapshot.position?.status === 'ready' &&
  validLeg(snapshot.position.bybit) &&
  validLeg(snapshot.position.fundingPips) &&
  validDecision(snapshot.decision) &&
  snapshot.position.bybit.direction === snapshot.decision.bybitDirection &&
  snapshot.position.fundingPips.direction === snapshot.decision.fpDirection.toUpperCase() &&
  typeof snapshot.ticket === 'string' &&
  snapshot.ticket.length > 0 &&
  snapshot.ticket.length <= 10_000
);

export function createTradeSnapshot({
  position,
  values,
  intelligence,
  now = Date.now(),
}) {
  const horizonMs = Number(intelligence?.horizonMs);
  const decision = intelligence?.decision;
  if (
    position?.status !== 'ready' ||
    !validLeg(position.bybit) ||
    !validLeg(position.fundingPips) ||
    position.bybit.direction !== decision?.bybitDirection ||
    position.fundingPips.direction !== decision?.fpDirection?.toUpperCase() ||
    !values ||
    typeof values.instrument !== 'string' ||
    !isPositive(values.entryPrice) ||
    !validDecision(decision) ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(horizonMs) ||
    horizonMs < 60_000 ||
    horizonMs > MAX_HORIZON_MS
  ) {
    throw new Error('A confirmed complete trade is required for locking.');
  }

  const expiresAt = now + horizonMs;
  const normalizedPosition = clone(position);
  const normalizedDecision = {
    ...clone(decision),
    outcomeAnchorPrice: Number(values.entryPrice),
    generatedAt: now,
  };
  const normalizedValues = clone({
    instrument: values.instrument,
    entryPrice: Number(values.entryPrice),
    fpDirection: values.fpDirection,
    slPct: Number(values.slPct),
    stage: values.stage,
    accountPreset: values.accountPreset,
    rrRatio: Number(values.rrRatio),
  });
  const snapshot = {
    version: SNAPSHOT_VERSION,
    id: `${now}-${Math.round(Number(values.entryPrice) * 100_000)}`,
    createdAt: now,
    expiresAt,
    expired: false,
    instrument: values.instrument,
    entryPrice: Number(values.entryPrice),
    values: normalizedValues,
    position: normalizedPosition,
    decision: normalizedDecision,
    sentiment: clone(intelligence.sentiment ?? decision.sentiment ?? null),
    regime: intelligence.regime ?? null,
    source: decision.source,
    reasons: clone(decision.reasons ?? intelligence.reasons ?? []),
    ticket: buildSnapshotTicket(
      normalizedPosition,
      values.instrument,
      normalizedDecision,
    ),
  };
  return deepFreeze(snapshot);
}

export function loadTradeSnapshot(
  storage = globalThis.localStorage,
  now = Date.now(),
) {
  if (!storage?.getItem || !Number.isSafeInteger(now) || now <= 0) return null;
  let parsed;
  try {
    const raw = storage.getItem(TRADE_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!validSnapshot(parsed)) return null;
  return deepFreeze({
    ...parsed,
    expired: now >= parsed.expiresAt,
  });
}

export function persistTradeSnapshot(
  snapshot,
  storage = globalThis.localStorage,
) {
  if (!validSnapshot(snapshot) || !storage?.getItem || !storage?.setItem) {
    throw new Error('Trade snapshot persistence input is invalid.');
  }
  const existing = storage.getItem(TRADE_SNAPSHOT_STORAGE_KEY);
  if (existing) {
    try {
      if (validSnapshot(JSON.parse(existing))) {
        throw new Error('A trade snapshot already exists; unlock it explicitly first.');
      }
    } catch (error) {
      if (/already exists/.test(error?.message ?? '')) throw error;
    }
  }
  const stored = { ...clone(snapshot) };
  delete stored.expired;
  storage.setItem(TRADE_SNAPSHOT_STORAGE_KEY, JSON.stringify(stored));
  return snapshot;
}

export function clearTradeSnapshot(storage = globalThis.localStorage) {
  storage?.removeItem?.(TRADE_SNAPSHOT_STORAGE_KEY);
}

export function resolveTradeView({
  livePosition,
  liveEntryPrice,
  snapshot,
}) {
  if (!snapshot) {
    return {
      position: livePosition,
      marketNowPrice: Number(liveEntryPrice),
      lockedEntryPrice: null,
      locked: false,
      expired: false,
    };
  }
  return {
    position: snapshot.position,
    marketNowPrice: Number(liveEntryPrice),
    lockedEntryPrice: snapshot.entryPrice,
    locked: true,
    expired: snapshot.expired === true,
  };
}
