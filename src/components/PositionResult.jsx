import React, { useEffect, useRef, useState } from 'react';

import { formatMoney, formatPrice } from '../format.js';
import { buildTradeTicket } from '../domain/tradeTicket.js';

const QUOTE_LABELS = {
  live: 'QUOTE LIVE',
  manual: 'PRICE MANUAL',
  stale: 'QUOTE STALE',
  connecting: 'QUOTE WAIT',
  connected: 'QUOTE WAIT',
  reconnecting: 'QUOTE WAIT',
  error: 'QUOTE ERROR',
  off: 'PRICE MANUAL',
};

const DIRECTION_LABELS = {
  locked: 'DIRECTION LOCKED',
  ready: 'DIRECTION READY',
  manual: 'DIRECTION MANUAL',
  waiting: 'DIRECTION WAIT',
};

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

export default function PositionResult({
  result,
  rrRatio,
  instrument,
  locked = false,
  expired = false,
  lockedEntryPrice = null,
  marketNowPrice = null,
  quoteStatus = 'manual',
  directionStatus = 'manual',
  canLock = false,
  prepareTradeCopy = () => null,
}) {
  const [copyStatus, setCopyStatus] = useState('idle');
  const [quickDocked, setQuickDocked] = useState(false);
  const sectionRef = useRef(null);

  useEffect(() => {
    setCopyStatus('idle');
  }, [instrument, result]);

  useEffect(() => {
    const updateDocked = () => {
      const section = sectionRef.current;
      const mobile = window.matchMedia('(max-width: 720px)').matches;
      if (!section || !mobile || result.status !== 'ready') {
        setQuickDocked(false);
        return;
      }
      const sectionTop = section.getBoundingClientRect().top + window.scrollY;
      const activationPoint = Math.max(0, sectionTop - window.innerHeight * 0.45);
      setQuickDocked(window.scrollY >= activationPoint);
    };

    updateDocked();
    window.addEventListener('scroll', updateDocked, { passive: true });
    window.addEventListener('resize', updateDocked);
    return () => {
      window.removeEventListener('scroll', updateDocked);
      window.removeEventListener('resize', updateDocked);
    };
  }, [result.status]);

  const copyTrade = async () => {
    const ticket = prepareTradeCopy() ?? buildTradeTicket(result, instrument);
    if (!ticket) return;

    const copyWithFallback = () => {
      const textarea = document.createElement('textarea');
      textarea.value = ticket;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } finally {
        textarea.remove();
      }
      if (!copied) throw new Error('copy command failed');
    };

    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(ticket);
        } catch {
          copyWithFallback();
        }
      } else {
        copyWithFallback();
      }
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };
  const tpSlReady = result.status === 'ready' &&
    [result.bybit, result.fundingPips].every((leg) => (
      Number(leg?.takeProfit) > 0 && Number(leg?.stopLoss) > 0
    ));
  const readiness = [
    {
      label: QUOTE_LABELS[quoteStatus] ?? 'QUOTE WAIT',
      ready: quoteStatus === 'live' || quoteStatus === 'manual' || quoteStatus === 'off',
    },
    { label: 'RISK OK', ready: result.status === 'ready' },
    {
      label: DIRECTION_LABELS[directionStatus] ?? 'DIRECTION WAIT',
      ready: ['locked', 'ready', 'manual'].includes(directionStatus),
    },
    { label: 'TP/SL READY', ready: tpSlReady },
  ];
  const idleCopyLabel = locked
    ? 'Скопировать зафиксированную сделку'
    : canLock
      ? 'Зафиксировать и скопировать'
      : 'Копировать сделку';

  return (
    <section
      ref={sectionRef}
      className="position-result"
      aria-labelledby="execution-title"
      aria-live="polite"
    >
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

      {locked ? (
        <div className={`trade-lock-context ${expired ? 'is-expired' : ''}`} role="status">
          <span>
            {expired ? 'FROZEN SNAPSHOT · EXPIRED' : 'FROZEN SNAPSHOT · ACTIVE'}
          </span>
          <strong>
            LOCKED {formatPrice(lockedEntryPrice, result.decimals)}
          </strong>
          <span>
            MARKET NOW {formatPrice(marketNowPrice, result.decimals)}
          </span>
        </div>
      ) : null}

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

      {result.status === 'ready' ? (
        <div
          className={`quick-actions ${quickDocked ? 'is-docked' : ''}`}
          aria-hidden={!quickDocked}
        >
          <ul className="execution-readiness" aria-label="Готовность сделки">
            {readiness.map((item) => (
              <li className={item.ready ? 'is-ready' : 'is-waiting'} key={item.label}>
                <i aria-hidden="true" />
                {item.label}
              </li>
            ))}
          </ul>
          <button
            className="copy-trade"
            type="button"
            onClick={copyTrade}
            tabIndex={quickDocked ? 0 : -1}
          >
            <span aria-hidden="true">⧉</span>
            {copyStatus === 'copied' ? 'Значения скопированы' : idleCopyLabel}
          </button>
          <span className="copy-status" role="status" aria-live="polite">
            {copyStatus === 'failed' ? 'Не удалось скопировать — разрешите доступ к буферу.' : ''}
          </span>
        </div>
      ) : null}
    </section>
  );
}
