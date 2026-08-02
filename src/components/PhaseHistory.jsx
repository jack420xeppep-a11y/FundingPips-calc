import React, { useMemo } from 'react';

import { formatSignedMoney, formatSignedMoneyFixed } from '../format.js';

export default function PhaseHistory({ checkpoint, selectedDay, onDayChange }) {
  const recordedByDay = useMemo(() => new Map(
    checkpoint.recordedDays.map((record) => [record.day, record]),
  ), [checkpoint.recordedDays]);

  return (
    <section className="phase-history" aria-labelledby="phase-history-title">
      <header className="phase-history__head">
        <div>
          <span className="section-code">Recorded timeline</span>
          <h3 id="phase-history-title">История дней</h3>
        </div>
        <div className="phase-history__economics" aria-label="Денежный итог журнала">
          <span>
            Эффект Bybit от старта <b className={checkpoint.bybitPnl >= 0 ? 'positive' : 'negative'}>
              {formatSignedMoney(checkpoint.bybitPnl)}
            </b>
          </span>
          <span>
            Цена пропа{checkpoint.purchaseDiscountPct > 0
              ? ` (−${checkpoint.purchaseDiscountPct}%)`
              : ''}{' '}
            <b className="negative">{formatSignedMoneyFixed(-checkpoint.propCost)}</b>
          </span>
          <span>
            Чистыми от старта <b className={checkpoint.netCashResult >= 0 ? 'positive' : 'negative'}>
              {formatSignedMoneyFixed(checkpoint.netCashResult)}
            </b>
          </span>
        </div>
      </header>
      <div className={`phase-history__list ${checkpoint.dayCount === 4 ? 'has-four-days' : ''}`} role="list">
        {Array.from({ length: checkpoint.dayCount }, (_, index) => index + 1).map((day) => {
          const record = recordedByDay.get(day);
          return (
            <div key={day} role="listitem">
              <button
                type="button"
                className={selectedDay === day ? 'is-selected' : ''}
                aria-pressed={selectedDay === day}
                onClick={() => onDayChange(day)}
              >
                <span className="phase-history__day">День {day}</span>
                {record ? (
                  <>
                    <span>
                      <small>FundingPips {record.outcome.toUpperCase()}</small>
                      <b className={record.fpPnl >= 0 ? 'positive' : 'negative'}>
                        {formatSignedMoney(record.fpPnl)}
                      </b>
                    </span>
                    <span>
                      <small>Bybit {record.bybitOutcome.toUpperCase()}</small>
                      <b className={record.bybitPnl >= 0 ? 'positive' : 'negative'}>
                        {formatSignedMoney(record.bybitPnl)}
                      </b>
                    </span>
                  </>
                ) : (
                  <span className="phase-history__empty">Не записан</span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
