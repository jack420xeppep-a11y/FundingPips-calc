import React from 'react';

const pct = (value) => `${Math.round(Number(value ?? 0) * 100)}%`;

const intentLabels = {
  'transfer-to-bybit': 'Перелив на Bybit',
  'transfer-to-fundingpips': 'Перелив на FundingPips',
  'best-expected-value': 'Лучший Expected Value',
};

const formatState = (state) => String(state ?? 'WARMING').replaceAll('_', ' ');

const formatDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(Number(milliseconds ?? 0) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m ${seconds % 60}s`;
};

const formatTime = (timestamp) => {
  if (
    timestamp === null ||
    timestamp === undefined ||
    !Number.isFinite(Number(timestamp))
  ) {
    return '—';
  }
  return new Date(Number(timestamp)).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const formatSignedMoney = (value) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return 'WARMING';
  }
  const amount = Number(value);
  const absolute = Math.abs(amount);
  const compact = absolute >= 1_000_000
    ? `$${(absolute / 1_000_000).toFixed(1)}M`
    : absolute >= 1_000
      ? `$${(absolute / 1_000).toFixed(0)}K`
      : `$${absolute.toFixed(0)}`;
  return `${amount >= 0 ? '+' : '−'}${compact}`;
};

function ProbabilityPath({ direction, path, primary }) {
  return (
    <div className={`intelligence-path ${primary ? 'is-primary' : ''}`}>
      <span>{direction}</span>
      <strong>{pct(path?.probability)}</strong>
      <small>{path?.label ?? 'Waiting for a stable path'}</small>
    </div>
  );
}

function PressureRow({ label, sentiment }) {
  const score = sentiment?.score !== null &&
    sentiment?.score !== undefined &&
    Number.isFinite(Number(sentiment.score))
    ? Number(sentiment.score)
    : null;
  const direction = score === null
    ? 'WARMING'
    : sentiment.direction;
  const normalized = score === null ? 0 : Math.max(-100, Math.min(100, score));

  return (
    <div
      className={`pressure-row pressure-row--${String(direction).toLowerCase()}`}
      style={{ '--pressure-size': `${Math.abs(normalized) / 2}%` }}
      aria-label={`${label}: ${direction}${score === null ? '' : ` ${Math.abs(Math.round(score))} из 100`}`}
    >
      <span>{label}</span>
      <div className="pressure-track" aria-hidden="true">
        <i />
        <b />
      </div>
      <strong>
        {score === null ? direction : `${direction} ${Math.abs(Math.round(score))}/100`}
      </strong>
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

  const liveSnapshot = state.snapshot;
  const decision = tradeSnapshot?.decision ?? liveSnapshot?.decision;
  const paths = decision?.paths ?? liveSnapshot?.paths;
  const probabilities = paths
    ? [paths.down.probability, paths.up.probability, paths.neither.probability]
    : [];
  const maximum = probabilities.length ? Math.max(...probabilities) : null;
  const direction = decision?.fpDirection ??
    liveSnapshot?.recommendation?.stableDirection ??
    liveSnapshot?.recommendation?.fpDirection;
  const bybitDirection = direction === 'long' ? 'SHORT' : direction === 'short' ? 'LONG' : '—';
  const expired = tradeSnapshot?.expired === true;
  const actionable = !syncing && !expired && (
    decision?.autoEligible === true ||
    liveSnapshot?.recommendation?.autoEligible === true
  );
  const stateName = expired
    ? 'EXPIRED'
    : locked
      ? `LOCKED_${String(direction ?? '').toUpperCase()}`
      : syncing
        ? 'SYNCING'
        : decision?.state ?? 'WARMING';
  const sentiment = tradeSnapshot?.sentiment ??
    decision?.sentiment ??
    liveSnapshot?.sentiment ?? {};
  const whale = sentiment.whale ?? {};
  const market = sentiment.market ?? {};
  const combined = sentiment.combined ?? {};
  const generatedAt = tradeSnapshot?.createdAt ??
    liveSnapshot?.generatedAt ??
    decision?.generatedAt;
  const stableForMs = !syncing && decision?.stableSince
    ? Math.max(0, Number(generatedAt) - Number(decision.stableSince))
    : 0;
  const reasons = tradeSnapshot?.reasons ??
    decision?.reasons ??
    liveSnapshot?.reasons ??
    [];
  const horizonMs = liveSnapshot?.horizonMs ?? (
    tradeSnapshot ? tradeSnapshot.expiresAt - tradeSnapshot.createdAt : 0
  );

  return (
    <section
      className={`intelligence-panel intelligence-panel--${stateName.toLowerCase()} ${locked ? 'is-locked' : ''}`}
      aria-labelledby="intelligence-title"
      aria-live="polite"
    >
      <header className="intelligence-head">
        <div>
          <span className="section-code">HL Intelligence / xyz:GOLD</span>
          <h2 id="intelligence-title">Calm sentiment contour</h2>
        </div>
        <span className="intelligence-status">
          <i aria-hidden="true" />{formatState(stateName)}
        </span>
      </header>

      {decision || liveSnapshot ? (
        <>
          <div className="intelligence-recommendation">
            <div>
              <span>Стабильный вывод</span>
              <strong>
                {actionable || locked
                  ? `FP ${direction?.toUpperCase() ?? '—'} / BYBIT ${bybitDirection}`
                  : 'WAIT / MANUAL DIRECTION'}
              </strong>
              <small>
                {syncing
                  ? 'Нужно 60 секунд свежего одинакового подтверждения'
                  : expired
                    ? 'Горизонт сделки завершён — snapshot сохранён до unlock'
                    : `${decision?.source ?? 'MARKET_ONLY'} · ${formatState(decision?.state)}`}
              </small>
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

          {paths ? (
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
          ) : null}

          <div className="sentiment-brief" aria-label="Агрегированный рыночный sentiment">
            <PressureRow label="Market sentiment" sentiment={market} />
            <PressureRow label="Whale sentiment" sentiment={whale} />
            <PressureRow label="Combined" sentiment={combined} />
          </div>

          <div className="decision-timing">
            <div><span>STATE</span><strong>{formatState(stateName)}</strong></div>
            <div><span>STABLE FOR</span><strong>{formatDuration(stableForMs)}</strong></div>
            <div>
              <span>NEXT SWITCH EARLIEST</span>
              <strong>{formatTime(syncing ? null : decision?.nextSwitchAllowedAt)}</strong>
            </div>
          </div>

          <div className="intelligence-advanced">
            <div className="whale-ledger">
              <div>
                <span>Qualified whales</span>
                <strong>{whale.qualifiedCount ?? 0}</strong>
              </div>
              <div>
                <span>New positions 15m</span>
                <strong>
                  {whale.status === 'ready'
                    ? `${whale.newPositions15m?.short ?? 0} SHORT / ${whale.newPositions15m?.long ?? 0} LONG`
                    : 'WARMING'}
                </strong>
              </div>
              <div>
                <span>Net change 15m</span>
                <strong>{formatSignedMoney(whale.netPositionChange15m)}</strong>
              </div>
              <div>
                <span>Net change 1h</span>
                <strong>{formatSignedMoney(whale.netPositionChange1h)}</strong>
              </div>
              <div>
                <span>Entry cluster</span>
                <strong>
                  {Number.isFinite(whale.entryCluster?.p25)
                    ? `${whale.entryCluster.p25}–${whale.entryCluster.p75}`
                    : 'WARMING'}
                </strong>
              </div>
              <div>
                <span>Conviction / freshness</span>
                <strong>
                  {whale.status === 'ready'
                    ? `${whale.conviction} · ${Math.round((whale.freshnessMs ?? 0) / 1_000)}s`
                    : 'LOW · WARMING'}
                </strong>
              </div>
            </div>

            <div className="intelligence-meta">
              <dl>
                <div><dt>Уверенность</dt><dd>{pct(decision?.confidence ?? liveSnapshot?.confidence)}</dd></div>
                <div><dt>Зрелость модели</dt><dd>{pct(whale.maturity ?? liveSnapshot?.maturity)}</dd></div>
                <div><dt>Источник</dt><dd>{decision?.source ?? 'MARKET_ONLY'}</dd></div>
                <div><dt>Горизонт</dt><dd>{Math.round(horizonMs / 3_600_000)}h</dd></div>
              </dl>
              <label className="intelligence-intent" htmlFor="intelligence-intent">
                <span>Цель рекомендации</span>
                <select
                  id="intelligence-intent"
                  value={intent}
                  onChange={(event) => onIntentChange(event.target.value)}
                  disabled={locked}
                >
                  {Object.entries(intentLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            </div>

            <details className="intelligence-details">
              <summary>Почему система удерживает это направление</summary>
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
          <strong>{formatState(stateName)}</strong>
          <span>
            {state.message || 'Синхронизирую Hyperliquid, Bybit и устойчивую модель решения.'}
          </span>
        </div>
      )}
    </section>
  );
}
