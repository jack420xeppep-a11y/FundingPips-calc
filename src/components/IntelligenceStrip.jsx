import React from 'react';
import {
  buildIntelligenceStripView,
  formatProbability,
} from './intelligence-strip-view.js';

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
  const view = buildIntelligenceStripView({
    liveSnapshot,
    tradeSnapshot,
    locked,
    syncing,
  });

  return (
    <section
      className={`intelligence-strip intelligence-strip--${view.stateLabel.toLowerCase()}`}
      aria-label="Краткий вывод HL Intelligence"
      aria-live="polite"
    >
      <span className="intelligence-strip__mode"><i aria-hidden="true" />HL AUTO</span>
      <span className="intelligence-strip__direction">
        <small>{view.directionMode}</small>
        <strong>{view.directionText}</strong>
      </span>
      <span className="intelligence-strip__paths" aria-label="Прогноз движения">
        {view.paths.map((path) => (
          <span
            className={`intelligence-strip__path ${path.primary ? 'is-primary' : ''}`}
            key={path.key}
          >
            <small>{path.label}</small>
            <strong>{formatProbability(path.probability)}</strong>
          </span>
        ))}
      </span>
      <span className="intelligence-strip__state">{view.stateLabel}</span>
      <small className="intelligence-strip__note">{view.noteText}</small>
    </section>
  );
}
