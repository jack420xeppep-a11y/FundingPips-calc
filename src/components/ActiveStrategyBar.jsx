import React from 'react';

import { formatMoney } from '../format.js';

export default function ActiveStrategyBar({ profile }) {
  if (!profile) return null;

  return (
    <section
      className={`active-strategy-bar ${profile.id === 'custom' ? 'is-custom' : ''}`}
      aria-label="Активный профиль стратегии"
    >
      <div className="active-strategy-bar__identity">
        <span>ACTIVE PROFILE</span>
        <strong>{profile.label}</strong>
      </div>
      <dl>
        <div><dt>P1</dt><dd>{formatMoney(profile.stakes.bybitP1, 1)}</dd></div>
        <div><dt>P2</dt><dd>{formatMoney(profile.stakes.bybitP2, 1)}</dd></div>
        <div><dt>Funded</dt><dd>{formatMoney(profile.stakes.bybitFunded, 1)}</dd></div>
        <div><dt>payout</dt><dd>{Number(profile.fundedPayout).toFixed(0)}%</dd></div>
      </dl>
    </section>
  );
}
