import React, { useEffect, useState } from 'react';

import { formatMoney, formatSignedMoney } from '../format.js';
import { getSchemeBybitPnl } from '../domain/propRules.js';
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
  suggestedBybitWin,
  suggestedBybitLoss,
  onDayChange,
  onRecord,
  onReset,
}) {
  const entry = checkpoint.selectedEntry;
  const [draft, setDraft] = useState(() => ({
    outcome: entry.outcome,
    amount: entry.amount,
  }));
  useEffect(() => {
    setDraft({
      outcome: entry.outcome,
      amount: entry.amount,
    });
  }, [
    checkpoint.stage,
    entry.amount,
    entry.outcome,
    selectedDay,
  ]);
  const canRecord = ['sl', 'tp'].includes(draft.outcome) &&
    Number(draft.amount) > 0;
  const schemeBybitPnl = getSchemeBybitPnl({
    accountModel: checkpoint.accountModel,
    accountSize: checkpoint.accountSize,
    stage: checkpoint.stage,
    day: selectedDay,
    outcome: draft.outcome,
  });
  const previewBybitPnl = schemeBybitPnl ?? (
    draft.outcome === 'sl'
      ? Number(suggestedBybitWin) || 0
      : draft.outcome === 'tp'
        ? -(Number(suggestedBybitLoss) || 0)
        : 0
  );
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
          <div className="phase-checkpoint__scheme" aria-live="polite">
            <span>Bybit по схеме</span>
            <b className={previewBybitPnl >= 0 ? 'positive' : 'negative'}>
              {draft.outcome === 'none' ? '—' : formatSignedMoney(previewBybitPnl)}
            </b>
            <small>
              {draft.outcome === 'none'
                ? 'Выберите исход дня'
                : draft.outcome === 'sl' ? 'TP Bybit автоматически' : 'SL Bybit автоматически'}
            </small>
          </div>
          <Field
            id="challengeCost"
            label="Цена пропа, $"
            value={challengeCost}
            onChange={() => {}}
            step="1"
            min="0"
            readOnly
            hint="Исходная покупка · отдельно от P&L"
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

      {checkpoint.resetOffer ? (
        <div className="phase-checkpoint__reset" role="status">
          <strong>Reset после breach</strong>
          <span>
            {checkpoint.resetOffer.label}: −{checkpoint.resetOffer.discountPct}% ·{' '}
            {formatMoney(checkpoint.resetOffer.resetPrice, 2)} · доступен 7 дней
          </span>
          <small>
            Текущий итог уже учитывает исходную покупку {formatMoney(checkpoint.propCost)};
            будущий reset в него не вычитается.
          </small>
        </div>
      ) : null}

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
