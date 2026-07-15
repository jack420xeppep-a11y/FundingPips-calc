import React from 'react';

import { formatMoney, formatPrice } from '../format.js';

function PriceCell({ kind, label, value, decimals }) {
  return (
    <div className={`price-cell price-cell--${kind}`}>
      <span className="price-cell__label">
        <b>{kind === 'tp' ? 'TP' : 'SL'}</b>
        {label}
      </span>
      <strong>{formatPrice(value, decimals)}</strong>
    </div>
  );
}

function PlatformLeg({ kind, leg, decimals, rrRatio }) {
  const isBybit = kind === 'bybit';

  return (
    <article className={`platform-leg platform-leg--${kind}`}>
      <header className="platform-leg__head">
        <span className="platform-mark" aria-hidden="true">
          {isBybit ? 'B' : 'FP'}
        </span>
        <div>
          <span className="platform-label">{leg.platform}</span>
          <strong>{leg.direction}</strong>
        </div>
        <span className="platform-role">{isBybit ? 'Hedge leg A' : 'Prop leg B'}</span>
      </header>

      <div className="lot-block">
        <strong className="lot-value">{leg.lots.toFixed(2)}</strong>
        <span className="lot-unit">LOTS / EXECUTION SIZE</span>
      </div>

      <div className="price-grid">
        <PriceCell
          kind="tp"
          label="Take profit"
          value={leg.takeProfit}
          decimals={decimals}
        />
        <PriceCell
          kind="sl"
          label="Stop loss"
          value={leg.stopLoss}
          decimals={decimals}
        />
      </div>

      <footer className="platform-leg__foot">
        {isBybit ? (
          <>
            <span><b className="positive">WIN</b> {formatMoney(leg.takeProfitPnl)}</span>
            <span><b className="negative">LOSS</b> {formatMoney(leg.stopLossPnl)}</span>
          </>
        ) : (
          <>
            <span><b>RISK</b> {leg.riskPct.toFixed(2)}%</span>
            <span><b>RR</b> 1:{Number(rrRatio).toFixed(1)}</span>
          </>
        )}
      </footer>
    </article>
  );
}

export default function PositionResult({ result, rrRatio }) {
  return (
    <section className="position-result" aria-labelledby="execution-title" aria-live="polite">
      <header className="section-head">
        <div>
          <span className="section-code">01 / Synchronized position</span>
          <h2 id="execution-title">Execution sizing</h2>
        </div>
        {result.status === 'ready' ? (
          <span className="exposure-pill">
            <i aria-hidden="true" /> SL FACT {result.actualSlPct.toFixed(3)}% / READY
          </span>
        ) : null}
      </header>

      {result.status === 'invalid' ? (
        <div className="inline-alert" role="alert">
          <strong>Расчёт приостановлен</strong>
          <span>{result.message}</span>
        </div>
      ) : (
        <div className="position-grid">
          <PlatformLeg
            kind="bybit"
            leg={result.bybit}
            decimals={result.decimals}
            rrRatio={rrRatio}
          />
          <div className="hedge-axis" aria-hidden="true">
            <span>OPPOSING</span>
          </div>
          <PlatformLeg
            kind="fp"
            leg={result.fundingPips}
            decimals={result.decimals}
            rrRatio={rrRatio}
          />
        </div>
      )}
    </section>
  );
}

