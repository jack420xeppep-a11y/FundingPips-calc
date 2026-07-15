import React, { useEffect, useMemo, useState } from 'react';

import PositionControls from './components/PositionControls.jsx';
import PositionResult from './components/PositionResult.jsx';
import RecoveryView from './components/RecoveryView.jsx';
import RiskRail from './components/RiskRail.jsx';
import ScenarioTable from './components/ScenarioTable.jsx';
import SettingsDeck from './components/SettingsDeck.jsx';
import ThemeToggle from './components/ThemeToggle.jsx';
import {
  INSTRUMENTS,
  calculatePosition,
  calculateRecovery,
  calculateScenarios,
  getAccountSettings,
} from './domain/calculator.js';

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

export default function App() {
  const [activeView, setActiveView] = useState('position');
  const [positionValues, setPositionValues] = useState(initialPosition);
  const [recoveryValues, setRecoveryValues] = useState(initialRecovery);
  const [theme, toggleTheme] = useTheme();

  const position = useMemo(() => calculatePosition(positionValues), [positionValues]);
  const scenarios = useMemo(() => calculateScenarios(positionValues), [positionValues]);
  const recovery = useMemo(() => calculateRecovery(recoveryValues), [recoveryValues]);

  const updatePosition = (field, value) => {
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
              <PositionControls values={positionValues} onChange={updatePosition} />
              <div className="workspace">
                <div className="primary-workspace">
                  <PositionResult result={position} rrRatio={positionValues.rrRatio} />
                  <SettingsDeck values={positionValues} onChange={updatePosition} />
                  <ScenarioTable scenarios={scenarios} />
                </div>
                <RiskRail values={positionValues} position={position} />
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
