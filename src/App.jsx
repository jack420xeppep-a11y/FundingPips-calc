import React, { useCallback, useEffect, useMemo, useState } from 'react';

import ActiveStrategyBar from './components/ActiveStrategyBar.jsx';
import PositionControls from './components/PositionControls.jsx';
import IntelligencePanel from './components/IntelligencePanel.jsx';
import IntelligenceStrip from './components/IntelligenceStrip.jsx';
import PositionResult from './components/PositionResult.jsx';
import RecoveryView from './components/RecoveryView.jsx';
import RiskRail from './components/RiskRail.jsx';
import ScenarioTable from './components/ScenarioTable.jsx';
import SettingsDeck from './components/SettingsDeck.jsx';
import StrategyLab from './components/StrategyLab.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import {
  INSTRUMENTS,
  calculatePosition,
  calculateRecovery,
  calculateScenarios,
  getAccountSettings,
} from './domain/calculator.js';
import {
  STRATEGY_GOALS,
  buildStrategyPresets,
  calculateBreakEven,
  optimizeStrategy,
} from './domain/strategies.js';
import {
  clearTradeSnapshot,
  createTradeSnapshot,
  loadTradeSnapshot,
  persistTradeSnapshot,
  resolveTradeView,
} from './domain/tradeSnapshot.js';
import useLivePrice from './hooks/useLivePrice.js';
import useGoldIntelligence from './hooks/useGoldIntelligence.js';

const initialPosition = {
  instrument: 'GBPUSD',
  entryPrice: 1.333,
  fpDirection: 'long',
  slPct: 0.22,
  stage: 'p1',
  accountPreset: '10k',
  p1Target: 8,
  p2Target: 5,
  maxDrawdown: 10,
  riskPerTrade: 2,
  rrRatio: 2,
  profitSplit: 0.8,
  fundedRisk: 1,
  fundedPayout: 8,
  ...getAccountSettings('10k', 2, 1),
};

const initialRecovery = {
  instrument: 'GBPUSD',
  entryPrice: 1.333,
  slPct: 0.075,
  rrRatio: 2,
  bybitTakeProfit: 2,
  multiplier: 1.5,
  fpBybitRatio: 8,
  steps: 10,
  widenFrom: 0,
  rangeMultiplier: 2,
};

const STRATEGY_VALUE_FIELDS = [
  'bybitP1',
  'bybitP2',
  'bybitFunded',
  'fundedPayout',
];

const strategyMatchesValues = (strategy, values) => {
  if (!strategy || !values) return false;
  const applied = strategy.applyValues ?? strategy.stakes ?? {};
  return STRATEGY_VALUE_FIELDS.every((field) => {
    const expected = applied[field] ?? strategy[field];
    return Number.isFinite(Number(expected)) &&
      Number(expected) === Number(values[field]);
  });
};

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return window.localStorage.getItem('calcpro-theme') || 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('calcpro-theme', theme);
    } catch {
      // Тема всё равно применяется, даже если хранилище браузера недоступно.
    }
  }, [theme]);

  return [theme, () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))];
}

function usePersistedBoolean(key, fallback = false) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? fallback : stored === 'true';
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // Автосинхронизация продолжает работать без сохранения настройки.
    }
  }, [key, value]);

  return [value, setValue];
}

export default function App() {
  const [activeView, setActiveView] = useState('position');
  const [positionValues, setPositionValues] = useState(initialPosition);
  const [recoveryValues, setRecoveryValues] = useState(initialRecovery);
  const [strategyGoal, setStrategyGoal] = useState('balanced');
  const [recommendation, setRecommendation] = useState(null);
  const [mobileAdvancedOpen, setMobileAdvancedOpen] = useState(false);
  const [autoPriceEnabled, setAutoPriceEnabled] = usePersistedBoolean(
    'calcpro-auto-price',
  );
  const [intelligenceEnabled, setIntelligenceEnabled] = usePersistedBoolean(
    'calcpro-hl-intelligence',
  );
  const [intelligenceIntent, setIntelligenceIntent] = useState('transfer-to-bybit');
  const [tradeSnapshot, setTradeSnapshot] = useState(() => loadTradeSnapshot());
  const [intelligenceResumeAfter, setIntelligenceResumeAfter] = useState(null);
  const [theme, toggleTheme] = useTheme();
  const intelligenceLocked = Boolean(tradeSnapshot);

  useEffect(() => {
    if (!tradeSnapshot) return;
    setPositionValues((current) => ({
      ...current,
      ...tradeSnapshot.values,
    }));
  }, [tradeSnapshot?.id]);

  useEffect(() => {
    if (!tradeSnapshot || tradeSnapshot.expired) return undefined;
    const delay = Math.max(0, tradeSnapshot.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setTradeSnapshot(loadTradeSnapshot());
    }, Math.min(delay + 10, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [tradeSnapshot?.id, tradeSnapshot?.expiresAt, tradeSnapshot?.expired]);

  const applyLivePrice = useCallback((quote) => {
    setPositionValues((current) => {
      if (current.instrument !== quote.instrument || current.entryPrice === quote.price) {
        return current;
      }
      return { ...current, entryPrice: quote.price };
    });
  }, []);

  const livePrice = useLivePrice({
    enabled: autoPriceEnabled,
    instrument: positionValues.instrument,
    onPrice: applyLivePrice,
  });

  const position = useMemo(() => calculatePosition(positionValues), [positionValues]);
  const scenarios = useMemo(() => calculateScenarios(positionValues), [positionValues]);
  const breakEven = useMemo(() => calculateBreakEven(positionValues), [positionValues]);
  const strategyPresets = useMemo(
    () => buildStrategyPresets(positionValues),
    [positionValues],
  );
  const activeStrategy = useMemo(() => {
    const preset = strategyPresets.find((strategy) => (
      strategyMatchesValues(strategy, positionValues)
    ));
    if (preset) return preset;
    if (
      recommendation?.status === 'ready' &&
      strategyMatchesValues(recommendation, positionValues)
    ) {
      return recommendation;
    }
    return {
      id: 'custom',
      label: 'Custom / Manual',
      stakes: {
        bybitP1: Number(positionValues.bybitP1),
        bybitP2: Number(positionValues.bybitP2),
        bybitFunded: Number(positionValues.bybitFunded),
      },
      fundedPayout: Number(positionValues.fundedPayout),
    };
  }, [positionValues, recommendation, strategyPresets]);
  const recovery = useMemo(() => calculateRecovery(recoveryValues), [recoveryValues]);
  const intelligenceAvailable = positionValues.instrument === 'XAUUSD';
  const intelligenceSetup = useMemo(() => (
    position.status === 'ready' && intelligenceAvailable
      ? {
          instrument: 'XAUUSD',
          entryPrice: Math.round(Number(positionValues.entryPrice) * 2) / 2,
          slPct: Number(positionValues.slPct),
          rrRatio: Number(positionValues.rrRatio),
          stage: positionValues.stage,
          accountSize: Number(positionValues.accountSize),
          riskPerTrade: Number(positionValues.riskPerTrade),
          fundedRisk: Number(positionValues.fundedRisk),
          profitSplit: Number(positionValues.profitSplit),
          bybitStake: Number(position.stake),
          intent: intelligenceIntent,
        }
      : null
  ), [position, positionValues, intelligenceAvailable, intelligenceIntent]);

  const applyIntelligenceDirection = useCallback((direction) => {
    setPositionValues((current) => (
      current.fpDirection === direction ? current : { ...current, fpDirection: direction }
    ));
  }, []);

  const intelligence = useGoldIntelligence({
    enabled: intelligenceEnabled && intelligenceAvailable && position.status === 'ready',
    setup: intelligenceSetup,
    locked: intelligenceLocked,
    onDirection: applyIntelligenceDirection,
    resumeAfter: intelligenceResumeAfter,
    onResynced: () => setIntelligenceResumeAfter(null),
  });
  const liveIntelligenceDecision = intelligence.snapshot?.decision;
  const canLockTrade = Boolean(
    !tradeSnapshot &&
    intelligenceEnabled &&
    intelligenceAvailable &&
    liveIntelligenceDecision?.autoEligible &&
    ['long', 'short'].includes(liveIntelligenceDecision.fpDirection),
  );

  const tradeView = useMemo(() => resolveTradeView({
    livePosition: position,
    liveEntryPrice: positionValues.entryPrice,
    snapshot: tradeSnapshot,
  }), [position, positionValues.entryPrice, tradeSnapshot]);

  const lockCurrentTrade = useCallback(() => {
    if (tradeSnapshot) return tradeSnapshot;
    const intelligenceSnapshot = intelligence.snapshot;
    const decision = intelligenceSnapshot?.decision;
    if (
      !intelligenceEnabled ||
      !intelligenceAvailable ||
      !decision?.autoEligible ||
      !['long', 'short'].includes(decision.fpDirection)
    ) {
      return null;
    }
    const lockedValues = {
      ...positionValues,
      fpDirection: decision.fpDirection,
    };
    const lockedPosition = calculatePosition(lockedValues);
    try {
      const snapshot = createTradeSnapshot({
        position: lockedPosition,
        values: lockedValues,
        intelligence: intelligenceSnapshot,
        now: Date.now(),
      });
      persistTradeSnapshot(snapshot);
      setPositionValues(lockedValues);
      setTradeSnapshot(snapshot);
      setIntelligenceResumeAfter(null);
      return snapshot;
    } catch {
      return null;
    }
  }, [
    intelligence.snapshot,
    intelligenceAvailable,
    intelligenceEnabled,
    positionValues,
    tradeSnapshot,
  ]);

  const unlockTrade = useCallback(() => {
    if (!tradeSnapshot) return;
    clearTradeSnapshot();
    setTradeSnapshot(null);
    setIntelligenceResumeAfter(Date.now());
  }, [tradeSnapshot]);

  const updatePosition = (field, value) => {
    setRecommendation(null);
    setPositionValues((current) => {
      if (field === 'instrument') {
        const instrument = INSTRUMENTS[value];
        if (!instrument) return current;

        return {
          ...current,
          instrument: value,
          entryPrice: instrument.defaultPrice,
        };
      }

      if (field === 'accountPreset') {
        return {
          ...current,
          accountPreset: value,
          ...getAccountSettings(value, current.riskPerTrade, current.fundedRisk),
        };
      }

      if (field === 'riskPerTrade' || field === 'fundedRisk') {
        const next = { ...current, [field]: value };
        return {
          ...next,
          ...getAccountSettings(next.accountPreset, next.riskPerTrade, next.fundedRisk),
        };
      }

      return { ...current, [field]: value };
    });
  };

  const applyStrategy = (strategy) => {
    if (strategy?.status !== 'ready') return;
    setPositionValues((current) => ({
      ...current,
      ...(strategy.applyValues ?? strategy.stakes),
    }));
    setRecommendation(strategy);
  };

  const updateRecovery = (field, value) => {
    setRecoveryValues((current) => {
      if (field !== 'instrument') return { ...current, [field]: value };

      const instrument = INSTRUMENTS[value];
      if (!instrument) return current;

      return { ...current, instrument: value, entryPrice: instrument.defaultPrice };
    });
  };

  const handleViewKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role="tab"]')];
    const currentIndex = tabs.indexOf(event.currentTarget);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    setActiveView(tabs[nextIndex].dataset.view);
  };

  return (
    <>
      <a className="skip-link" href="#main">К содержимому</a>
      <header className="app-bar">
        <a className="product-mark" href="./" aria-label="CalcPro, на главную">
          <span>CP</span>
          <div><strong>CALCPRO</strong><small>PROP / HEDGE ENGINE</small></div>
        </a>

        <nav className="view-tabs" aria-label="Разделы калькулятора" role="tablist">
          <button
            id="tab-position"
            type="button"
            role="tab"
            data-view="position"
            aria-selected={activeView === 'position'}
            aria-controls="panel-position"
            tabIndex={activeView === 'position' ? 0 : -1}
            className={activeView === 'position' ? 'active' : ''}
            onClick={() => setActiveView('position')}
            onKeyDown={handleViewKeyDown}
          >
            <span>01</span> Калькулятор позиции
          </button>
          <button
            id="tab-recovery"
            type="button"
            role="tab"
            data-view="recovery"
            aria-selected={activeView === 'recovery'}
            aria-controls="panel-recovery"
            tabIndex={activeView === 'recovery' ? 0 : -1}
            className={activeView === 'recovery' ? 'active' : ''}
            onClick={() => setActiveView('recovery')}
            onKeyDown={handleViewKeyDown}
          >
            <span>02</span> Лестница восстановления
          </button>
        </nav>

        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </header>

      <main id="main" className="app-shell">
        <article className="console">
          <header className="console-head">
            <div>
              <span className="console-id">Risk console / engine.01</span>
              <h1>Prop Hedge Position Engine</h1>
            </div>
            <div className="engine-status"><i aria-hidden="true" />Local calculation / ready</div>
          </header>

          {activeView === 'position' ? (
            <div id="panel-position" role="tabpanel" aria-labelledby="tab-position">
              <PositionControls
                values={positionValues}
                onChange={updatePosition}
                autoPriceEnabled={autoPriceEnabled}
                onAutoPriceChange={setAutoPriceEnabled}
                livePrice={livePrice}
                intelligenceEnabled={intelligenceEnabled}
                intelligenceAvailable={intelligenceAvailable}
                onIntelligenceChange={(enabled) => {
                  setIntelligenceEnabled(enabled);
                }}
              />
              <ActiveStrategyBar profile={activeStrategy} />
              <div className={`workspace ${mobileAdvancedOpen ? 'advanced-open' : ''}`}>
                <div className="primary-workspace">
                  <IntelligenceStrip
                    enabled={intelligenceEnabled || intelligenceLocked}
                    available={intelligenceAvailable || intelligenceLocked}
                    state={intelligence}
                    locked={intelligenceLocked}
                    tradeSnapshot={tradeSnapshot}
                    syncing={intelligenceResumeAfter !== null}
                  />
                  <PositionResult
                    result={tradeView.position}
                    rrRatio={tradeSnapshot?.values.rrRatio ?? positionValues.rrRatio}
                    instrument={tradeSnapshot?.instrument ?? positionValues.instrument}
                    locked={tradeView.locked}
                    expired={tradeView.expired}
                    lockedEntryPrice={tradeView.lockedEntryPrice}
                    marketNowPrice={tradeView.marketNowPrice}
                    quoteStatus={autoPriceEnabled ? livePrice.status : 'manual'}
                    directionStatus={
                      intelligenceLocked
                        ? 'locked'
                        : canLockTrade
                          ? 'ready'
                          : intelligenceEnabled && intelligenceAvailable
                            ? 'waiting'
                            : 'manual'
                    }
                    canLock={canLockTrade}
                    prepareTradeCopy={() => (
                      tradeSnapshot?.ticket ??
                      lockCurrentTrade()?.ticket ??
                      null
                    )}
                  />
                  {(intelligenceEnabled || intelligenceLocked) &&
                  (intelligenceAvailable || intelligenceLocked) ? (
                    <details className="intelligence-disclosure">
                      <summary>
                        <span>
                          <strong>HL Intelligence details</strong>
                          <small>Вероятности, Whale Pressure и причины решения</small>
                        </span>
                        <i aria-hidden="true" />
                      </summary>
                      <IntelligencePanel
                        enabled={intelligenceEnabled || intelligenceLocked}
                        available={intelligenceAvailable || intelligenceLocked}
                        state={intelligence}
                        intent={intelligenceIntent}
                        onIntentChange={setIntelligenceIntent}
                        locked={intelligenceLocked}
                        tradeSnapshot={tradeSnapshot}
                        syncing={intelligenceResumeAfter !== null}
                        onLockToggle={() => {
                          if (intelligenceLocked) {
                            unlockTrade();
                          } else {
                            lockCurrentTrade();
                          }
                        }}
                      />
                    </details>
                  ) : null}
                  <button
                    className="mobile-advanced-toggle"
                    type="button"
                    aria-expanded={mobileAdvancedOpen}
                    aria-controls="advanced-controls"
                    onClick={() => setMobileAdvancedOpen((current) => !current)}
                  >
                    <span>
                      <strong>Расширенные настройки</strong>
                      <small>Стратегии, параметры и сценарии цикла</small>
                    </span>
                    <i aria-hidden="true">{mobileAdvancedOpen ? '−' : '+'}</i>
                  </button>
                  <div id="advanced-controls" className="advanced-content">
                    <SettingsDeck values={positionValues} onChange={updatePosition} />
                    <StrategyLab
                      goals={STRATEGY_GOALS}
                      selectedGoal={strategyGoal}
                      onGoalChange={(goal) => {
                        setStrategyGoal(goal);
                        setRecommendation(null);
                      }}
                      recommendation={recommendation}
                      presets={strategyPresets}
                      activeStrategyId={activeStrategy.id}
                      onOptimize={() => setRecommendation(
                        optimizeStrategy(positionValues, strategyGoal),
                      )}
                      onApply={applyStrategy}
                    />
                    <ScenarioTable scenarios={scenarios} />
                  </div>
                </div>
                <RiskRail values={positionValues} position={position} breakEven={breakEven} />
              </div>
            </div>
          ) : (
            <div id="panel-recovery" role="tabpanel" aria-labelledby="tab-recovery">
              <RecoveryView values={recoveryValues} result={recovery} onChange={updateRecovery} />
            </div>
          )}
        </article>

        <footer className="app-footer">
          <span>CALCPRO / LOCAL ENGINE</span>
          <span>Расчётный инструмент — не исполняет сделки</span>
        </footer>
      </main>
    </>
  );
}
