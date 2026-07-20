import React from 'react';

import Field from './Field.jsx';

export default function SettingsDeck({ values, onChange }) {
  return (
    <section className="settings-deck" aria-labelledby="settings-title">
      <header className="section-head settings-deck__head">
        <div>
          <span className="section-code">02 / Strategy controls</span>
          <h2 id="settings-title">Параметры стратегии</h2>
        </div>
        <span className="micro-copy">Все значения пересчитываются локально</span>
      </header>

      <div className="settings-grid">
        <details className="settings-group settings-group--fp" open>
          <summary>
            <span><i aria-hidden="true" />FundingPips</span>
            <small>Account & challenge</small>
          </summary>
          <div className="settings-fields">
            <Field
              id="accountPreset"
              label="Аккаунт"
              value={values.accountPreset}
              onChange={onChange}
              options={[
                { value: '10k', label: '$10K' },
                { value: '25k', label: '$25K' },
                { value: '50k', label: '$50K' },
                { value: '100k', label: '$100K' },
              ]}
            />
            <Field id="p1Target" label="Phase 1 цель, %" value={values.p1Target} onChange={onChange} step="1" min="1" />
            <Field id="p2Target" label="Phase 2 цель, %" value={values.p2Target} onChange={onChange} step="1" min="1" />
            <Field id="maxDrawdown" label="Макс. просадка, %" value={values.maxDrawdown} onChange={onChange} step="1" min="1" />
            <Field id="riskPerTrade" label="Риск на сделку, %" value={values.riskPerTrade} onChange={onChange} step="0.5" min="0.1" />
            <Field id="rrRatio" label="RR, TP / SL" value={values.rrRatio} onChange={onChange} step="0.5" min="0.5" />
            <Field
              id="profitSplit"
              label="Profit split"
              value={values.profitSplit}
              onChange={onChange}
              options={[
                { value: 0.6, label: 'Weekly — 60%' },
                { value: 0.8, label: 'Bi-Weekly — 80%' },
                { value: 0.9, label: 'On Demand — 90%' },
                { value: 1, label: 'Monthly — 100%' },
              ]}
            />
            <Field id="fundedRisk" label="Риск Funded, %" value={values.fundedRisk} onChange={onChange} step="0.5" min="0.1" />
          </div>
        </details>

        <details className="settings-group settings-group--bybit" open>
          <summary>
            <span><i aria-hidden="true" />Bybit</span>
            <small>Stakes & payout</small>
          </summary>
          <div className="settings-fields settings-fields--bybit">
            <Field id="bybitP1" label="Phase 1, $ за сделку" value={values.bybitP1} onChange={onChange} step="1" min="0.1" />
            <Field id="bybitP2" label="Phase 2, $ за сделку" value={values.bybitP2} onChange={onChange} step="1" min="0.1" />
            <Field id="bybitFunded" label="Funded, $ за сделку" value={values.bybitFunded} onChange={onChange} step="1" min="0.1" />
            <Field
              id="fundedPayout"
              label="Профит до выплаты, %"
              value={values.fundedPayout}
              onChange={onChange}
              step="0.01"
              min="0.01"
              hint="Точный порог безубытка рассчитывается автоматически"
            />
          </div>
        </details>

        <details className="settings-group settings-group--fees" open>
          <summary>
            <span><i aria-hidden="true" />Комиссии</span>
            <small>Fees & churn</small>
          </summary>
          <div className="settings-fields settings-fields--fees">
            <Field
              id="feesEnabled"
              label="Учёт комиссий"
              value={values.feesEnabled}
              onChange={onChange}
              options={[
                { value: true, label: 'Учитывать' },
                { value: false, label: 'Fee-free модель' },
              ]}
            />
            <Field
              id="bybitFeePct"
              label="Bybit fee, % за сторону"
              value={values.bybitFeePct}
              onChange={onChange}
              step="0.005"
              min="0"
              hint="Gold perp: мейкер 0, тейкер 0.0275. Крипто: 0.055 / 0.02"
            />
            <Field
              id="fpCommissionPerLot"
              label="FP, $ за лот (round turn)"
              value={values.fpCommissionPerLot}
              onChange={onChange}
              step="0.5"
              min="0"
              hint="FundingPips 2-Step: $5 (FX и металлы), Zero: $7. Спред — надбавкой сюда"
            />
            <Field
              id="winRate"
              label="Ожидаемый winrate, %"
              value={values.winRate}
              onChange={onChange}
              step="5"
              min="1"
              max="99"
              hint="Для оценки числа сделок в цикле"
            />
          </div>
        </details>
      </div>
    </section>
  );
}
