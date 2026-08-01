import React, { useEffect, useState } from 'react';

import { formatMoney, formatSignedMoney } from '../format.js';
import Field from './Field.jsx';
import PhaseHistory from './PhaseHistory.jsx';

const statusCopy = {
  tracking: ['Этап в работе', 'Добавьте результат выбранного дня'],
  passed: ['Условия этапа выполнены', 'Цель и обязательные дни закрыты'],
  target_reached_days_pending: ['Цель достигнута', 'Осталось выполнить требование по дням'],
  breached: ['Лимит нарушен', 'Проверьте дневную и общую просадку'],
};

export default function PhaseCheckpoint({
  checkpoint,
  selectedDay,
  challengeCost,
  officialChallengeCost,
  discountedPurchase,
  suggestedBybitWin,
  suggestedBybitLoss,
  onDayChange,
  onChallengeCostChange,
  onDiscountedPurchaseChange,
  onRecord,
  onReset,
}) {
  const entry = checkpoint.selectedEntry;
  const recordedEntry = checkpoint.recordedDays.find(
    (record) => record.day === Number(selectedDay),
  );
  const resolveBybitAmount = () => entry.bybitAmount ?? Math.abs(
    recordedEntry?.bybitPnl ?? (
      entry.outcome === 'sl'
        ? Number(suggestedBybitWin) || 0
        : entry.outcome === 'tp'
          ? Number(suggestedBybitLoss) || 0
          : 0
    ),
  );
  const [draft, setDraft] = useState(() => ({
    outcome: entry.outcome,
    amount: entry.amount,
    bybitAmount: resolveBybitAmount(),
  }));
  useEffect(() => {
    setDraft({
      outcome: entry.outcome,
      amount: entry.amount,
      bybitAmount: resolveBybitAmount(),
    });
  }, [
    checkpoint.stage,
    entry.amount,
    entry.bybitAmount,
    entry.outcome,
    recordedEntry?.bybitPnl,
    selectedDay,
    suggestedBybitLoss,
    suggestedBybitWin,
  ]);
  const canRecord = ['sl', 'tp'].includes(draft.outcome) &&
    Number(draft.amount) > 0 && Number(draft.bybitAmount) >= 0;
  const selectedDayRecorded = checkpoint.recordedDays.some(
    (record) => record.day === Number(selectedDay),
  );
  const [statusTitle, statusDetail] = statusCopy[checkpoint.status] ?? statusCopy.tracking;
  const dayRequirement = checkpoint.requiredTradingDays > 0
    ? `${checkpoint.tradingDays}/${checkpoint.requiredTradingDays} торговых дней`
    : checkpoint.requiredProfitableDays > 0
      ? `${checkpoint.profitableDays}/${checkpoint.requiredProfitableDays} прибыльных дней`
      : 'Без минимальных дней';

  return (
    <section className="phase-checkpoint" aria-labelledby="phase-checkpoint-title">
      <header className="phase-checkpoint__head">
        <div>
          <span className="section-code">Phase checkpoint / {checkpoint.modelLabel}</span>
          <h2 id="phase-checkpoint-title">Журнал этапа</h2>
        </div>
        <div className={`phase-checkpoint__status is-${checkpoint.status}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span><strong>{statusTitle}</strong><small>{statusDetail}</small></span>
        </div>
      </header>

      <div className="phase-checkpoint__body">
        <div className="phase-checkpoint__controls">
          <Field
            id="phaseDay"
            label="День этапа"
            value={selectedDay}
            onChange={(_field, value) => onDayChange(value)}
            options={[
              { value: 1, label: 'ДЕНЬ 1' },
              { value: 2, label: 'ДЕНЬ 2' },
              { value: 3, label: 'ДЕНЬ 3' },
            ]}
          />
          <Field
            id="phaseOutcome"
            label="Что случилось"
            value={draft.outcome}
            onChange={(_field, value) => setDraft((current) => ({
              ...current,
              outcome: value,
              bybitAmount: value === 'sl'
                ? Number(suggestedBybitWin) || 0
                : value === 'tp'
                  ? Number(suggestedBybitLoss) || 0
                  : 0,
            }))}
            options={[
              { value: 'none', label: 'Не задано' },
              { value: 'sl', label: 'SL / убыток' },
              { value: 'tp', label: 'TP / прибыль' },
            ]}
          />
          <Field
            id="phaseAmount"
            label="Итог дня, $"
            value={draft.amount}
            onChange={(_field, value) => setDraft((current) => ({ ...current, amount: value }))}
            step="1"
            min="0"
            readOnly={draft.outcome === 'none'}
            hint="Чистый закрытый P&L этого дня"
          />
          <Field
            id="phaseBybitAmount"
            label="Итог Bybit, $"
            value={draft.bybitAmount}
            onChange={(_field, value) => setDraft((current) => ({
              ...current,
              bybitAmount: value,
            }))}
            step="1"
            min="0"
            readOnly={draft.outcome === 'none'}
            hint="Фактический итог всех сделок Bybit за день"
          />
          <Field
            id="challengeCost"
            label="Оплачено за проп, $"
            value={challengeCost}
            onChange={(_field, value) => onChallengeCostChange(value)}
            step="1"
            min="0"
            readOnly={!discountedPurchase}
            hint={`Базовая цена ${formatMoney(officialChallengeCost)} · отдельно от P&L`}
            after={(
              <label className="prop-discount-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(discountedPurchase)}
                  onChange={(event) => onDiscountedPurchaseChange(event.target.checked)}
                />
                <span className="prop-discount-box" aria-hidden="true">✓</span>
                <span className="prop-discount-copy">
                  <b>Скидка / restart</b>
                  <small>Phase 1 −15% · Phase 2 −10% · Master −7% (кроме 100K)</small>
                </span>
              </label>
            )}
          />
        </div>

        <div className="phase-checkpoint__rules" aria-label="Правила выбранного этапа">
          <button
            className="phase-checkpoint__record"
            type="button"
            disabled={!canRecord}
            onClick={() => onRecord(draft)}
          >
            {selectedDayRecorded ? 'Обновить день' : 'Записать день'}
          </button>
          <span>Цель <b>{checkpoint.targetPct}%</b></span>
          <span>День <b>−{checkpoint.dailyLossPct}%</b></span>
          <span>Общий <b>−{checkpoint.maxLossPct}%</b></span>
          <span>{dayRequirement}</span>
          <button type="button" onClick={onReset}>Сбросить этап</button>
        </div>
      </div>

      <dl className="phase-checkpoint__summary">
        <div>
          <dt>P&amp;L этапа</dt>
          <dd className={checkpoint.realizedPnl >= 0 ? 'positive' : 'negative'}>
            {formatSignedMoney(checkpoint.realizedPnl)}
          </dd>
        </div>
        <div>
          <dt>До цели</dt>
          <dd>{formatMoney(checkpoint.remainingToTarget)}</dd>
        </div>
        <div>
          <dt>Лимит выбранного дня</dt>
          <dd>{formatMoney(checkpoint.selectedDayLossLimit)}</dd>
        </div>
        <div>
          <dt>Запас до общего лимита</dt>
          <dd className={checkpoint.remainingLossRoom > 0 ? 'positive' : 'negative'}>
            {formatMoney(checkpoint.remainingLossRoom)}
          </dd>
        </div>
      </dl>

      <PhaseHistory
        checkpoint={checkpoint}
        selectedDay={selectedDay}
        onDayChange={onDayChange}
      />

      {checkpoint.concentrationTriggered ? (
        <p className="phase-checkpoint__warning">
          Идея превысила 60% цели ({formatMoney(checkpoint.concentrationThreshold)}):
          evaluation не провалена, но будущий Master потребует 4 прибыльных дня перед выплатой.
        </p>
      ) : null}
      {checkpoint.tradeIdeaLimitAmount !== null ? (
        <p className="phase-checkpoint__note">
          Flex Master {formatMoney(checkpoint.accountSize)}:
          лимит одной торговой идеи {checkpoint.tradeIdeaLimitPct}% ({formatMoney(checkpoint.tradeIdeaLimitAmount)}).
        </p>
      ) : (
        <p className="phase-checkpoint__note">
          Дневной лимит FundingPips считается также по плавающей equity; журнал отражает введённый закрытый P&amp;L.
        </p>
      )}
    </section>
  );
}
