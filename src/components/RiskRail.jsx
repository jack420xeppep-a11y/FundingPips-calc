import React from 'react';

import { formatMoney } from '../format.js';

export default function RiskRail({ values, position }) {
  const currentRisk = values.stage === 'funded' ? values.fundedRisk : values.riskPerTrade;
  const utilization = Math.min(100, (Number(currentRisk) / Number(values.maxDrawdown || 1)) * 100);
  const available = Math.max(0, Number(values.maxDrawdown) - Number(currentRisk));
  const accountLabel = `$${Number(values.accountSize / 1000).toFixed(0)}K`;

  return (
    <aside className="risk-rail" aria-label="Лимиты и статус риска">
      <section className="risk-block">
        <span className="section-code">Account / FP-{accountLabel.replace('$', '')}</span>
        <h2>Challenge limits</h2>
        <dl>
          <div><dt>Account</dt><dd>{accountLabel}</dd></div>
          <div><dt>Challenge fee</dt><dd>{formatMoney(values.challengeCost)}</dd></div>
          <div><dt>Phase 1 target</dt><dd>{Number(values.p1Target).toFixed(2)}%</dd></div>
          <div><dt>Phase 2 target</dt><dd>{Number(values.p2Target).toFixed(2)}%</dd></div>
          <div><dt>Max drawdown</dt><dd className="negative">−{Number(values.maxDrawdown).toFixed(2)}%</dd></div>
          <div><dt>Profit split</dt><dd className="positive">{Number(values.profitSplit * 100).toFixed(0)}%</dd></div>
        </dl>
      </section>

      <section className="risk-block">
        <span className="section-code">Capacity / selected trade</span>
        <h2>Risk utilization</h2>
        <dl>
          <div><dt>Stage</dt><dd>{position.status === 'ready' ? position.stage : '—'}</dd></div>
          <div><dt>Used</dt><dd>{Number(currentRisk || 0).toFixed(2)}%</dd></div>
          <div><dt>Available</dt><dd className="positive">{available.toFixed(2)}%</dd></div>
        </dl>
        <div
          className="limit-bar"
          style={{ '--risk-used': `${utilization}%` }}
          role="img"
          aria-label={`Использовано ${utilization.toFixed(0)} процентов лимита риска`}
        >
          <span />
        </div>
      </section>
    </aside>
  );
}

