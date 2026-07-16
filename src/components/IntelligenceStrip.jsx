import React from 'react';

const pct = (value) => `${Math.round(Number(value ?? 0) * 100)}%`;

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

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(Number(milliseconds ?? 0) / 1_000));
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

export default function IntelligenceStrip({
  enabled,
  available,
  state,
  locked,
  tradeSnapshot,
  syncing = false,
}) {
  if (!available || !enabled) return null;

  const liveSnapshot = state.snapshot;
  const decision = tradeSnapshot?.decision ?? liveSnapshot?.decision;
  const direction = decision?.fpDirection ??
    liveSnapshot?.recommendation?.stableDirection ??
    liveSnapshot?.recommendation?.fpDirection;
  const bybitDirection = direction === 'long' ? 'SHORT' : direction === 'short' ? 'LONG' : '—';
  const generatedAt = tradeSnapshot?.createdAt ??
    liveSnapshot?.generatedAt ??
    decision?.generatedAt;
  const stableForMs = !syncing && decision?.stableSince
    ? Math.max(0, Number(generatedAt) - Number(decision.stableSince))
    : 0;
  const stateName = tradeSnapshot?.expired
    ? 'EXPIRED'
    : locked
      ? 'LOCKED'
      : syncing
        ? 'SYNCING'
        : decision?.state ?? 'WARMING';
  const actionable = locked || decision?.autoEligible === true ||
    liveSnapshot?.recommendation?.autoEligible === true;
  const confidence = decision?.confidence ?? liveSnapshot?.confidence;
  const stateLabel = stateName === 'LOCKED'
    ? 'LOCKED'
    : stateLabels[stateName] ?? String(stateName).replaceAll('_', ' ');

  return (
    <section
      className={`intelligence-strip intelligence-strip--${stateLabel.toLowerCase()}`}
      aria-label="Краткий вывод HL Intelligence"
      aria-live="polite"
    >
      <span className="intelligence-strip__mode"><i aria-hidden="true" />HL AUTO</span>
      <strong>
        {actionable && direction
          ? `FP ${direction.toUpperCase()} / BB ${bybitDirection}`
          : 'WAIT / MANUAL'}
      </strong>
      <span className="intelligence-strip__confidence">
        {Number.isFinite(Number(confidence)) ? pct(confidence) : '—'}
      </span>
      <span className="intelligence-strip__state">{stateLabel}</span>
      <small>{stateLabel === 'CONFIRMED' || stateLabel === 'LOCKED'
        ? `stable ${formatDuration(stableForMs)}`
        : 'ожидание устойчивого сигнала'}</small>
    </section>
  );
}
