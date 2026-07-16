import React from 'react';

const STATUS_LABELS = {
  connecting: 'CONNECTING',
  connected: 'WARMING',
  reconnecting: 'RECONNECTING',
  warming: 'WARMING',
  ready: 'LIVE',
  no_edge: 'NO EDGE',
  stale: 'STALE',
  degraded: 'DEGRADED',
  error: 'ERROR',
};

const PATH_FALLBACK = {
  down: 'BB TP / FP SL',
  up: 'BB SL / FP TP',
  neither: 'No barrier inside horizon',
};

const pct = (value) => `${(Number(value ?? 0) * 100).toFixed(0)}%`;

const intentLabels = {
  'transfer-to-bybit': 'Перелив на Bybit',
  'transfer-to-fundingpips': 'Перелив на FundingPips',
  'best-expected-value': 'Лучший Expected Value',
};

function ProbabilityPath({ direction, path, primary }) {
  return (
    <div className={`intelligence-path ${primary ? 'is-primary' : ''}`}>
      <span>{direction}</span>
      <strong>{pct(path?.probability)}</strong>
      <small>{path?.label ?? PATH_FALLBACK[direction.toLowerCase()]}</small>
    </div>
  );
}

export default function IntelligencePanel({
  enabled,
  available,
  state,
  intent,
  onIntentChange,
  locked,
  tradeSnapshot,
  syncing = false,
  onLockToggle,
}) {
  if (!available || !enabled) return null;
  const snapshot = state.snapshot;
  const frozenDecision = tradeSnapshot?.decision;
  const decision = frozenDecision ?? snapshot?.decision;
  const status = tradeSnapshot?.expired
    ? 'stale'
    : syncing
      ? 'warming'
      : snapshot?.status ?? state.status;
  const statusLabel = STATUS_LABELS[status] ?? 'WARMING';
  const paths = decision?.paths ?? snapshot?.paths;
  const probabilities = paths
    ? [paths.down.probability, paths.up.probability, paths.neither.probability]
    : [];
  const maximum = probabilities.length ? Math.max(...probabilities) : null;
  const direction = decision?.fpDirection ??
    snapshot?.recommendation?.stableDirection ??
    snapshot?.recommendation?.fpDirection;
  const bybitDirection = direction === 'long' ? 'SHORT' : direction === 'short' ? 'LONG' : '—';
  const actionable = !syncing && !tradeSnapshot?.expired && (
    decision?.autoEligible === true ||
    snapshot?.recommendation?.autoEligible === true
  ) && status !== 'no_edge';
  const confidence = frozenDecision?.confidence ?? snapshot?.confidence;
  const maturity = tradeSnapshot?.sentiment?.whale?.maturity ?? snapshot?.maturity;
  const cohortSize = tradeSnapshot?.sentiment?.whale?.qualifiedCount ??
    snapshot?.cohortSize;
  const reasons = tradeSnapshot?.reasons ?? decision?.reasons ?? snapshot?.reasons ?? [];
  const horizonMs = snapshot?.horizonMs ?? (
    tradeSnapshot ? tradeSnapshot.expiresAt - tradeSnapshot.createdAt : 0
  );
  const lockedTargetProbability = direction === 'long'
    ? decision?.probabilities?.down
    : decision?.probabilities?.up;

  return (
    <section
      className={`intelligence-panel intelligence-panel--${status} ${locked ? 'is-locked' : ''}`}
      aria-labelledby="intelligence-title"
      aria-live="polite"
    >
      <header className="intelligence-head">
        <div>
          <span className="section-code">HL Intelligence / xyz:GOLD</span>
          <h2 id="intelligence-title">Predictive direction contour</h2>
        </div>
        <span className="intelligence-status">
          <i aria-hidden="true" />
          {tradeSnapshot?.expired ? 'EXPIRED' : locked ? 'LOCKED' : syncing ? 'SYNCING' : statusLabel}
        </span>
      </header>

      {snapshot || tradeSnapshot ? (
        <>
          <div className="intelligence-recommendation">
            <div>
              <span>Рекомендация</span>
              <strong>
                {actionable || locked
                  ? `FP ${direction?.toUpperCase() ?? '—'} / BYBIT ${bybitDirection}`
                  : 'NO EDGE / MANUAL DIRECTION'}
              </strong>
            </div>
            {actionable || locked ? (
              <button
                type="button"
                className="intelligence-lock"
                onClick={onLockToggle}
              >
                {locked ? 'Разблокировать AUTO' : 'Зафиксировать сделку'}
              </button>
            ) : (
              <span className="intelligence-manual-note">
                AUTO ждёт подтверждённого преимущества
              </span>
            )}
          </div>

          <div className="intelligence-paths">
            <ProbabilityPath
              direction="DOWN"
              path={paths.down}
              primary={paths.down.probability === maximum}
            />
            <ProbabilityPath
              direction="UP"
              path={paths.up}
              primary={paths.up.probability === maximum}
            />
            <ProbabilityPath
              direction="NEITHER"
              path={paths.neither}
              primary={paths.neither.probability === maximum}
            />
          </div>

          <div className="intelligence-advanced">
            <div className="intelligence-meta">
              <dl>
                <div><dt>Уверенность</dt><dd>{pct(confidence)}</dd></div>
                <div><dt>Зрелость модели</dt><dd>{pct(maturity)}</dd></div>
                <div><dt>Когорта</dt><dd>{cohortSize ?? 0} traders</dd></div>
                <div><dt>Горизонт</dt><dd>{Math.round(horizonMs / 3_600_000)}h</dd></div>
              </dl>
              <label className="intelligence-intent" htmlFor="intelligence-intent">
                <span>Цель рекомендации</span>
                <select
                  id="intelligence-intent"
                  value={intent}
                  onChange={(event) => onIntentChange(event.target.value)}
                >
                  {Object.entries(intentLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="intelligence-signal-grid">
              <div><span>Market</span><strong>{pct(snapshot?.marketSignal ?? lockedTargetProbability)}</strong></div>
              <div><span>Wallet</span><strong>{pct(snapshot?.walletSignal ?? lockedTargetProbability)}</strong></div>
              <div><span>Combined</span><strong>{pct(snapshot?.combinedSignal ?? lockedTargetProbability)}</strong></div>
              <div><span>Regime</span><strong>{tradeSnapshot?.regime ?? snapshot?.regime}</strong></div>
            </div>

            <details className="intelligence-details">
              <summary>Почему система выбрала направление</summary>
              <ul>
                {reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
              <small>
                Только аналитика: сделки не исполняются, комиссии и спред не учитываются.
              </small>
            </details>
          </div>
        </>
      ) : (
        <div className="intelligence-placeholder">
          <strong>{statusLabel}</strong>
          <span>
            {state.message || 'Синхронизирую Hyperliquid, Bybit и текущую модель. Ручной режим доступен.'}
          </span>
        </div>
      )}
    </section>
  );
}
