import React from 'react';

import { formatSignedMoney } from '../format.js';

const signedClass = (value) => (value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral');

export default function ScenarioTable({ scenarios }) {
  return (
    <section className="table-section" aria-labelledby="scenario-title">
      <header className="section-head">
        <div>
          <span className="section-code">04 / Cycle ledger</span>
          <h2 id="scenario-title">Сценарии одного цикла</h2>
        </div>
        <span className="micro-copy">Signed P&L / USD</span>
      </header>
      <div className="table-scroll" tabIndex="0" aria-label="Таблица сценариев, прокручивается горизонтально">
        <table>
          <thead>
            <tr>
              <th scope="col">Сценарий</th>
              <th scope="col">Bybit расходы</th>
              <th scope="col">Челлендж</th>
              <th scope="col">Bybit от слива</th>
              <th scope="col">FP выплата</th>
              <th scope="col">Итого</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((scenario) => (
              <tr key={scenario.name}>
                <th scope="row">{scenario.name}</th>
                <td className="negative">{scenario.bybitExpenses ? formatSignedMoney(-scenario.bybitExpenses) : '—'}</td>
                <td className="negative">{formatSignedMoney(-scenario.challengeCost)}</td>
                <td className="positive">{formatSignedMoney(scenario.bybitRecovery)}</td>
                <td className="positive">{formatSignedMoney(scenario.fundingPipsPayout)}</td>
                <td className={signedClass(scenario.total)}>{formatSignedMoney(scenario.total, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
