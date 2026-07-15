import React from 'react';

import { INSTRUMENTS } from '../domain/calculator.js';
import { formatSignedMoney } from '../format.js';
import Field from './Field.jsx';

function RecoveryChart({ rows }) {
  const width = 760;
  const height = 190;
  const pad = 24;
  const values = rows.map((row) => row.recovery);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const x = (index) => pad + (index * (width - pad * 2)) / Math.max(1, rows.length - 1);
  const y = (value) => pad + ((max - value) * (height - pad * 2)) / range;
  const points = rows.map((row, index) => `${x(index)},${y(row.recovery)}`).join(' ');
  const zeroY = y(0);

  return (
    <svg className="recovery-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="recovery-chart-title recovery-chart-desc">
      <title id="recovery-chart-title">Кривая восстановления по ступеням</title>
      <desc id="recovery-chart-desc">Показывает расчётное восстановление FundingPips на каждой ступени.</desc>
      <g className="chart-grid">
        {[0.25, 0.5, 0.75].map((part) => (
          <line key={part} x1={pad} x2={width - pad} y1={height * part} y2={height * part} />
        ))}
      </g>
      <line className="chart-zero" x1={pad} x2={width - pad} y1={zeroY} y2={zeroY} />
      <polyline className="chart-line" points={points} />
      {rows.map((row, index) => (
        <circle key={row.step} className="chart-point" cx={x(index)} cy={y(row.recovery)} r="4" />
      ))}
    </svg>
  );
}

function RecoveryControls({ values, onChange }) {
  const update = (key) => (_, value) => onChange(key, value);

  return (
    <section className="recovery-controls" aria-labelledby="recovery-controls-title">
      <header className="section-head">
        <div>
          <span className="section-code">01 / Ladder controls</span>
          <h2 id="recovery-controls-title">Настройки ступеней</h2>
        </div>
        <span className="micro-copy">2–20 steps</span>
      </header>
      <div className="recovery-inputs">
        <Field
          id="recovery-instrument"
          label="Инструмент"
          value={values.instrument}
          onChange={update('instrument')}
          options={Object.keys(INSTRUMENTS).map((instrument) => ({ value: instrument, label: instrument }))}
        />
        <Field id="recovery-entryPrice" label="Цена входа" value={values.entryPrice} onChange={update('entryPrice')} step={INSTRUMENTS[values.instrument]?.step} min="0" />
        <Field id="recovery-slPct" label="SL диапазон, %" value={values.slPct} onChange={update('slPct')} step="0.005" min="0.01" />
        <Field id="recovery-rrRatio" label="RR, TP / SL" value={values.rrRatio} onChange={update('rrRatio')} step="0.5" min="1" />
        <Field id="recovery-bybitTakeProfit" label="Bybit TP старт, $" value={values.bybitTakeProfit} onChange={update('bybitTakeProfit')} step="0.5" min="0.5" />
        <Field id="recovery-multiplier" label="Множитель" value={values.multiplier} onChange={update('multiplier')} step="0.1" min="1.1" />
        <Field id="recovery-fpBybitRatio" label="FP / Bybit" value={values.fpBybitRatio} onChange={update('fpBybitRatio')} step="1" min="1" />
        <Field id="recovery-steps" label="Ступеней" value={values.steps} onChange={update('steps')} step="1" min="2" max="20" />
        <Field id="recovery-widenFrom" label="Расширить с шага" value={values.widenFrom} onChange={update('widenFrom')} step="1" min="0" max="20" />
        <Field id="recovery-rangeMultiplier" label="Множитель диапазона" value={values.rangeMultiplier} onChange={update('rangeMultiplier')} step="0.5" min="1" />
      </div>
    </section>
  );
}

export default function RecoveryView({ values, result, onChange }) {
  return (
    <div className="recovery-view">
      <RecoveryControls values={values} onChange={onChange} />

      {result.status === 'invalid' ? (
        <div className="inline-alert" role="alert">
          <strong>Лестница не рассчитана</strong>
          <span>{result.message}</span>
        </div>
      ) : (
        <>
          <section className="recovery-visual" aria-labelledby="recovery-visual-title" aria-live="polite">
            <header className="section-head">
              <div>
                <span className="section-code">02 / Recovery trajectory</span>
                <h2 id="recovery-visual-title">Лестница восстановления</h2>
              </div>
              <span className="exposure-pill"><i aria-hidden="true" /> {result.rows.length} STEPS / READY</span>
            </header>
            <div className="recovery-layout">
              <RecoveryChart rows={result.rows} />
              <dl className="recovery-summary">
                <div><dt>Первые сливы FP</dt><dd className="negative">−${result.summary.firstLosses.toFixed(0)}</dd></div>
                <div><dt>Bybit за все шаги</dt><dd className="positive">+${result.summary.cumulativeBybitWin.toFixed(0)}</dd></div>
                <div><dt>SL движение</dt><dd>{result.summary.baseSlPct}%{result.summary.widenedSlPct ? ` → ${result.summary.widenedSlPct}%` : ''}</dd></div>
                <div><dt>TP движение</dt><dd>{result.summary.baseTakeProfitPct}%{result.summary.widenedTakeProfitPct ? ` → ${result.summary.widenedTakeProfitPct}%` : ''}</dd></div>
              </dl>
            </div>
          </section>

          <section className="table-section" aria-labelledby="ladder-title">
            <header className="section-head">
              <div>
                <span className="section-code">03 / Recovery ledger</span>
                <h2 id="ladder-title">Таблица ступеней</h2>
              </div>
              <span className="micro-copy">{values.instrument} · RR 1:{values.rrRatio}</span>
            </header>
            <div className="table-scroll" tabIndex="0" aria-label="Таблица ступеней, прокручивается горизонтально">
              <table className="recovery-table">
                <thead>
                  <tr><th scope="col">#</th><th scope="col">FP лоты</th><th scope="col">Bybit лоты</th><th scope="col">Bybit TP</th><th scope="col">Bybit SL</th><th scope="col">FP win</th><th scope="col">FP lose</th><th scope="col">Σ слив FP</th><th scope="col">Восстановление</th></tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.step} className={row.rangeChanged ? 'range-change' : ''}>
                      <th scope="row">{String(row.step).padStart(2, '0')}{row.rangeChanged ? ' ×' : ''}</th>
                      <td>{row.fundingPipsLots.toFixed(2)}</td>
                      <td>{row.bybitLots.toFixed(2)}</td>
                      <td className="positive">{formatSignedMoney(row.bybitWin, 2)}</td>
                      <td className="negative">{formatSignedMoney(-row.bybitLoss, 2)}</td>
                      <td className="positive">{formatSignedMoney(row.fundingPipsWin)}</td>
                      <td className="negative">{formatSignedMoney(-row.fundingPipsLoss)}</td>
                      <td className="negative">{formatSignedMoney(-row.cumulativeLoss)}</td>
                      <td className={row.recovery >= 0 ? 'positive' : 'negative'}>{formatSignedMoney(row.recovery)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
