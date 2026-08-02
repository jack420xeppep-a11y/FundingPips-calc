import React from 'react';

import { formatMoney, formatSignedMoneyFixed } from '../format.js';
import Field from './Field.jsx';

const formatPayoutDate = (value) => {
  if (!value) return 'Укажите первую сделку';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

export default function PayoutPlan({ checkpoint, values, onChange }) {
  if (checkpoint.stage !== 'funded') return null;

  const daysRequired = checkpoint.payoutProfitableDaysRequired;
  const daysComplete = checkpoint.payoutProfitableDaysCompleted;
  const daysReady = checkpoint.payoutProfitableDaysRemaining === 0;
  const cycleLabel = checkpoint.rewardCycleDays === 0
    ? 'On Demand'
    : `${checkpoint.rewardCycleDays} дней`;

  return (
    <section className="payout-plan" aria-labelledby="payout-plan-title">
      <header className="payout-plan__head">
        <div>
          <span className="section-code">Experimental / payout route</span>
          <h2 id="payout-plan-title">План выплаты</h2>
        </div>
        <div className="payout-plan__identity">
          <span>{checkpoint.modelLabel}</span>
          <strong>{Math.round(checkpoint.profitSplit * 100)}% · {cycleLabel}</strong>
        </div>
      </header>

      <div className="payout-plan__inputs">
        <Field
          id="desiredNetProfit"
          label="Желаемый чистый фарм, $"
          value={values.desiredNetProfit}
          onChange={onChange}
          step="10"
          min="0"
          hint="Сверх пропа, Bybit и payout split"
        />
        <Field
          id="firstMasterTradeDate"
          label="Первая сделка Master"
          value={values.firstMasterTradeDate}
          onChange={onChange}
          type="date"
          hint="От неё начинается reward cycle"
        />
        <div className="payout-plan__farm">
          <span>Накопленный итог фермы</span>
          <strong className={checkpoint.netCashResult >= 0 ? 'positive' : 'negative'}>
            {formatSignedMoneyFixed(checkpoint.netCashResult)}
          </strong>
          <small>Фактический Bybit + выплата FP − цена пропа</small>
        </div>
      </div>

      <div className="payout-plan__targets" aria-label="Три уровня take profit">
        <article>
          <span>01 / TP нуля</span>
          <strong>{formatMoney(checkpoint.farmBreakEvenTpAmount, 2)}</strong>
          <small>Точная математическая безубыточность</small>
        </article>
        <article>
          <span>02 / TP желаемой прибыли</span>
          <strong>{formatMoney(checkpoint.desiredNetTpAmount, 2)}</strong>
          <small>Даёт чистыми {formatMoney(checkpoint.desiredNetProfit)}</small>
        </article>
        <article className="is-primary">
          <span>03 / TP ставить</span>
          <strong>{formatMoney(checkpoint.payoutReadyTpAmount)}</strong>
          <small>
            После split ожидается {formatSignedMoneyFixed(checkpoint.projectedFarmNetAtRecommendedTp)}
          </small>
        </article>
      </div>

      <div className="payout-plan__eligibility">
        <div>
          <span>Дата выплаты</span>
          <strong>{checkpoint.rewardCycleDays === 0
            ? 'On Demand'
            : formatPayoutDate(checkpoint.payoutAvailableDate)}</strong>
          <small className={checkpoint.payoutTimeReady ? 'positive' : ''}>
            {checkpoint.payoutTimeReady
              ? 'Временной gate выполнен'
              : values.firstMasterTradeDate ? 'Reward cycle идёт' : 'Укажите первую сделку'}
          </small>
        </div>
        <div>
          <span>Прибыльные дни</span>
          <strong>{daysRequired > 0 ? `${daysComplete} / ${daysRequired}` : 'Не требуются'}</strong>
          <small className={daysReady ? 'positive' : 'negative'}>
            {daysReady ? 'Gate выполнен' : `Осталось ${checkpoint.payoutProfitableDaysRemaining}`}
          </small>
        </div>
        <div>
          <span>Минимальная выплата</span>
          <strong>{formatMoney(checkpoint.minimumRewardAmount)}</strong>
          <small>
            После split · gross FP от {formatMoney(checkpoint.minimumRewardGrossAmount, 2)}
          </small>
        </div>
      </div>

      <div className="payout-plan__guards" aria-label="Ограничения payout-маршрута">
        <p className={checkpoint.evaluationConcentrationTriggered ? 'is-warning' : ''}>
          <strong>Profit Concentration</strong>
          <span>{checkpoint.accountSize >= 25_000
            ? checkpoint.evaluationConcentrationTriggered
              ? 'Порог 60% был превышен: на Master нужны 4 прибыльных дня по 0.5%.'
              : 'Порог 60% по записанным evaluation-дням не превышен.'
            : 'Для evaluation ниже $25K правило не применяется.'}</span>
          {checkpoint.accountSize >= 25_000 ? (
            <small>Для новых evaluation, купленных с 27.06.2026.</small>
          ) : null}
        </p>
        <p className={checkpoint.strikingThresholdAmount !== null ? 'is-warning' : ''}>
          <strong>Striking</strong>
          <span>{checkpoint.strikingThresholdAmount !== null
            ? `Standard Master: warning при floating loss идеи ${formatMoney(checkpoint.strikingThresholdAmount)} (1.2%).`
            : 'Для выбранной модели и размера отдельный Striking threshold не применяется.'}</span>
        </p>
        <p>
          <strong>Equity</strong>
          <span>Дневной и общий лимиты учитывают floating P&amp;L; журнал хранит закрытый факт.</span>
        </p>
      </div>
    </section>
  );
}
