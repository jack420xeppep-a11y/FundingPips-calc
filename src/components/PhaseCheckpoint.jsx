import React, { useEffect, useState } from 'react';

import { formatMoney, formatMoneyFixed, formatSignedMoney } from '../format.js';
import { getSchemeBybitPnl } from '../domain/propRules.js';
import Field from './Field.jsx';
import PhaseHistory from './PhaseHistory.jsx';

const statusCopy = {
  tracking: ['Этап в работе', 'Добавьте результат выбранного дня'],
  passed: ['Условия этапа выполнены', 'Цель и обязательные дни закрыты'],
  target_reached_days_pending: ['Цель достигнута', 'Осталось выполнить требование по дням'],
  breached: ['Лимит нарушен', 'Проверьте дневную и общую просадку'],
};

const resolveBybitReference = ({
  checkpoint,
  selectedDay,
  outcome,
  suggestedBybitWin,
  suggestedBybitLoss,
}) => {
  if (!['sl', 'tp'].includes(outcome)) {
    return { outcome: 'none', amount: 0, pnl: 0, source: 'reference' };
  }
  const schemePnl = getSchemeBybitPnl({
    accountModel: checkpoint.accountModel,
    accountSize: checkpoint.accountSize,
    stage: checkpoint.stage,
    day: selectedDay,
    outcome,
  });
  const pnl = schemePnl ?? (
    outcome === 'sl'
      ? Number(suggestedBybitWin) || 0
      : -(Number(suggestedBybitLoss) || 0)
  );
  return {
    outcome: pnl >= 0 ? 'tp' : 'sl',
    amount: Math.abs(pnl),
    pnl,
    source: schemePnl === null ? 'position' : 'reference',
  };
};

export default function PhaseCheckpoint({
  checkpoint,
  selectedDay,
  challengeCost,
  purchaseDiscountEnabled,
  purchaseDiscountPct,
  suggestedBybitWin,
  suggestedBybitLoss,
  onDayChange,
  onPurchaseDiscountChange,
  onRecord,
  onReset,
}) {
  const entry = checkpoint.selectedEntry;
  const createDraft = () => {
    const reference = resolveBybitReference({
      checkpoint,
      selectedDay,
      outcome: entry.outcome,
      suggestedBybitWin,
      suggestedBybitLoss,
    });
    return {
      outcome: entry.outcome,
      amount: entry.amount,
      bybitOutcome: entry.bybitOutcome ?? reference.outcome,
      bybitAmount: entry.bybitOutcome !== null
        ? entry.bybitAmount ?? 0
        : reference.amount,
      bybitSource: entry.bybitSource ?? reference.source,
    };
  };
  const [draft, setDraft] = useState(createDraft);
  useEffect(() => {
    setDraft(createDraft());
  }, [
    checkpoint.stage,
    entry.amount,
    entry.bybitAmount,
    entry.bybitOutcome,
    entry.bybitSource,
    entry.outcome,
    selectedDay,
    suggestedBybitLoss,
    suggestedBybitWin,
  ]);
  const canRecord = ['sl', 'tp'].includes(draft.outcome) &&
    Number(draft.amount) > 0 &&
    (draft.bybitOutcome === 'none' || (
      ['sl', 'tp'].includes(draft.bybitOutcome) && Number(draft.bybitAmount) > 0
    ));
  const referenceBybit = resolveBybitReference({
    checkpoint,
    selectedDay,
    outcome: draft.outcome,
    suggestedBybitWin,
    suggestedBybitLoss,
  });
  const applyReference = () => setDraft((current) => ({
    ...current,
    bybitOutcome: referenceBybit.outcome,
    bybitAmount: referenceBybit.amount,
    bybitSource: referenceBybit.source,
  }));
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
            options={Array.from({ length: checkpoint.dayCount }, (_, index) => ({
              value: index + 1,
              label: `ДЕНЬ ${index + 1}`,
            }))}
          />
          <Field
            id="phaseOutcome"
            label="Что случилось на FundingPips"
            value={draft.outcome}
            onChange={(_field, value) => {
              const reference = resolveBybitReference({
                checkpoint,
                selectedDay,
                outcome: value,
                suggestedBybitWin,
                suggestedBybitLoss,
              });
              setDraft((current) => ({
                ...current,
                outcome: value,
                amount: value === 'sl'
                  ? checkpoint.selectedDayLossLimit
                  : value === 'tp'
                    ? checkpoint.recommendedFarmTpAmount
                    : 0,
                bybitOutcome: reference.outcome,
                bybitAmount: reference.amount,
                bybitSource: reference.source,
              }));
            }}
            options={[
              { value: 'none', label: 'Не задано' },
              { value: 'sl', label: 'SL / убыток' },
              { value: 'tp', label: 'TP / прибыль' },
            ]}
          />
          <Field
            id="phaseAmount"
            label="Итог FundingPips, $"
            value={draft.amount}
            onChange={(_field, value) => setDraft((current) => ({ ...current, amount: value }))}
            step="1"
            min="0"
            readOnly={draft.outcome === 'none'}
            hint="Чистый закрытый P&L этого дня"
          />
          <Field
            id="bybitOutcome"
            label="Что случилось на Bybit"
            value={draft.bybitOutcome}
            onChange={(_field, value) => setDraft((current) => ({
              ...current,
              bybitOutcome: value,
              bybitAmount: value === 'none' ? 0 : current.bybitAmount || referenceBybit.amount,
              bybitSource: 'manual',
            }))}
            options={[
              { value: 'none', label: 'Нет сделки' },
              { value: 'tp', label: 'TP / прибыль' },
              { value: 'sl', label: 'SL / убыток' },
            ]}
          />
          <Field
            id="bybitAmount"
            label="Итог Bybit, $"
            value={draft.bybitAmount}
            onChange={(_field, value) => setDraft((current) => ({
              ...current,
              bybitAmount: value,
              bybitSource: 'manual',
            }))}
            step="1"
            min="0"
            readOnly={draft.bybitOutcome === 'none'}
            hint="Фактически закрытый результат"
          />
          <Field
            id="challengeCost"
            label="Цена пропа, $"
            value={checkpoint.propCost}
            onChange={() => {}}
            step="1"
            min="0"
            readOnly
            hint={purchaseDiscountEnabled
              ? `База ${formatMoney(challengeCost)} · к оплате ${formatMoneyFixed(checkpoint.propCost)}`
              : 'Базовая цена · отдельно от P&L'}
            after={(
              <div className="prop-purchase-discount">
                <label>
                  <input
                    type="checkbox"
                    checked={Boolean(purchaseDiscountEnabled)}
                    onChange={(event) => onPurchaseDiscountChange(
                      'purchaseDiscountEnabled',
                      event.target.checked,
                    )}
                  />
                  <span>Куплен со скидкой</span>
                </label>
                {purchaseDiscountEnabled ? (
                  <label htmlFor="purchaseDiscountPct">
                    <span>Скидка покупки, %</span>
                    <input
                      id="purchaseDiscountPct"
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="100"
                      step="1"
                      value={purchaseDiscountPct}
                      onChange={(event) => onPurchaseDiscountChange(
                        'purchaseDiscountPct',
                        Number(event.target.value),
                      )}
                    />
                  </label>
                ) : null}
              </div>
            )}
          />
          <div className="phase-checkpoint__scheme" aria-live="polite">
            <span>Эталон схемы</span>
            <b className={referenceBybit.pnl >= 0 ? 'positive' : 'negative'}>
              {draft.outcome === 'none' ? '—' : (
                <>Bybit {referenceBybit.outcome.toUpperCase()} {formatSignedMoney(referenceBybit.pnl)}</>
              )}
            </b>
            <small>
              {draft.outcome === 'none'
                ? 'Выберите исход FundingPips'
                : referenceBybit.source === 'reference'
                  ? 'Эталонная схема; фактические поля можно изменить'
                  : 'Подсказка из текущей позиции; фактические поля можно изменить'}
            </small>
            <button type="button" disabled={draft.outcome === 'none'} onClick={applyReference}>
              Подставить эталон
            </button>
          </div>
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
          <dt>SL по схеме дня</dt>
          <dd>{formatMoney(checkpoint.selectedDayLossLimit)}</dd>
        </div>
        <div>
          <dt>Запас до общего лимита</dt>
          <dd className={checkpoint.remainingLossRoom > 0 ? 'positive' : 'negative'}>
            {formatMoney(checkpoint.remainingLossRoom)}
          </dd>
        </div>
      </dl>

      <section className="phase-guidance" aria-labelledby="phase-guidance-title">
        <header>
          <div>
            <span className="section-code">Rules / route guard</span>
            <h3 id="phase-guidance-title">Правила и подсказки</h3>
          </div>
          <strong>{checkpoint.lossPlanPct.join(' / ')}%</strong>
        </header>
        <div className="phase-guidance__grid">
          <div>
            <span>Рабочая схема</span>
            <b>SL дня до {formatMoney(checkpoint.selectedDayLossLimit)}</b>
            <small>
              План {checkpoint.plannedLossPct}% от старта; остаток до общего breach перед днём{' '}
              {formatMoney(checkpoint.remainingLossRoomBeforeDay)}.
            </small>
          </div>
          <div>
            <span>{checkpoint.stage === 'funded' ? 'TP для фарма' : 'Рекомендуемый TP'}</span>
            <b>{formatMoney(checkpoint.recommendedFarmTpAmount)}</b>
            <small>
              {checkpoint.stage === 'funded'
                ? <>TP для нуля {formatMoney(checkpoint.farmBreakEvenTpAmount)}; после split и ожидаемого SL Bybit итог{' '}
                  {formatSignedMoney(checkpoint.projectedFarmNetAtRecommendedTp)}.</>
                : 'Перекрывает прошлые SL и доводит этап до цели.'}
            </small>
          </div>
          <div>
            <span>Официальные пределы</span>
            <b>День {checkpoint.dailyLossPct}% · общий {checkpoint.maxLossPct}%</b>
            <small>
              Потолок текущего дня {formatMoney(checkpoint.officialSelectedDayLossLimit)};
              рабочая схема намеренно ниже.
            </small>
          </div>
        </div>
        {checkpoint.concentrationThreshold !== null ? (
          <div className={`phase-guidance__policy ${
            checkpoint.recommendedTpTriggersConcentration ? 'is-warning' : ''
          }`}>
            <strong>60% Profit Concentration</strong>
            <span>
              Порог одной trade idea {formatMoney(checkpoint.concentrationThreshold)}.
              {checkpoint.recommendedTpTriggersConcentration
                ? ` Рекомендуемый TP ${formatMoney(checkpoint.recommendedTpAmount)} выше порога:`
                : ''}{' '}
              проход сохраняется, но будущий Master потребует 4 прибыльных дня перед выплатой.
            </span>
          </div>
        ) : (
          <p className="phase-guidance__policy">
            60% Profit Concentration не применяется к evaluation ниже $25K.
          </p>
        )}
      </section>

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
