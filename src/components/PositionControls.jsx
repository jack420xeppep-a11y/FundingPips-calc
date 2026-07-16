import React from 'react';

import { INSTRUMENTS } from '../domain/calculator.js';
import Field from './Field.jsx';

const instrumentOptions = Object.keys(INSTRUMENTS).map((instrument) => ({
  value: instrument,
  label: instrument,
}));

const statusCopy = {
  off: ['Ручной режим', 'Цена меняется в поле ввода'],
  connecting: ['Подключение к Bybit…', 'Получаю первый TradFi snapshot'],
  connected: ['Поток подключён', 'Ожидаю котировку выбранной пары'],
  reconnecting: ['Восстанавливаю поток…', 'Расчёт остаётся на последней цене'],
  stale: ['Котировка устарела', 'Ручной ввод доступен до свежего тика'],
  error: ['Поток временно недоступен', 'Можно продолжать с ручной ценой'],
};

const formatQuote = (quote) => {
  const decimals = INSTRUMENTS[quote.instrument]?.decimals ?? 5;
  return quote.price.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

export default function PositionControls({
  values,
  onChange,
  autoPriceEnabled,
  onAutoPriceChange,
  livePrice,
}) {
  const isLive = livePrice.status === 'live' && livePrice.quote;
  const [statusTitle, defaultStatusDetail] = isLive
    ? [
        `LIVE · ${livePrice.quote.bybitSymbol} · ${formatQuote(livePrice.quote)}`,
        `MID Bid/Ask · ${new Date(livePrice.quote.timestamp).toLocaleTimeString('ru-RU')}`,
      ]
    : statusCopy[livePrice.status] ?? statusCopy.error;
  const statusDetail = livePrice.status === 'error' && livePrice.message
    ? livePrice.message
    : defaultStatusDetail;

  return (
    <section className="position-controls" aria-label="Основные параметры позиции">
      <div className="live-price-bar">
        <label className="live-price-toggle" htmlFor="auto-price">
          <input
            id="auto-price"
            type="checkbox"
            checked={autoPriceEnabled}
            onChange={(event) => onAutoPriceChange(event.target.checked)}
          />
          <span className="live-price-switch" aria-hidden="true"><i /></span>
          <span>
            <strong>Автосинхронизация цены</strong>
            <small>CalcPro Relay · Bybit TradFi · MID без учёта спреда</small>
          </span>
        </label>

        <div
          className={`live-price-status live-price-status--${livePrice.status}`}
          role="status"
          aria-live="polite"
        >
          <i aria-hidden="true" />
          <span><strong>{statusTitle}</strong><small>{statusDetail}</small></span>
        </div>
      </div>

      <div className="input-rail">
        <Field
          id="instrument"
          label="Инструмент"
          value={values.instrument}
          onChange={onChange}
          options={instrumentOptions}
        />
        <Field
          id="entryPrice"
          label="Цена входа"
          value={values.entryPrice}
          onChange={onChange}
          step={INSTRUMENTS[values.instrument]?.step ?? 0.00001}
          min="0"
          readOnly={Boolean(isLive)}
        />
        <Field
          id="fpDirection"
          label="Направление FP"
          value={values.fpDirection}
          onChange={onChange}
          options={[
            { value: 'long', label: 'LONG' },
            { value: 'short', label: 'SHORT' },
          ]}
        />
        <Field
          id="slPct"
          label="SL от входа"
          value={values.slPct}
          onChange={onChange}
          step="0.01"
          min="0.01"
          max="10"
        />
        <Field
          id="stage"
          label="Этап"
          value={values.stage}
          onChange={onChange}
          options={[
            { value: 'p1', label: 'PHASE 1' },
            { value: 'p2', label: 'PHASE 2' },
            { value: 'funded', label: 'FUNDED' },
          ]}
        />
      </div>
    </section>
  );
}
