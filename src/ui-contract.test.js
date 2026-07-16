import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');
const readUi = async () => {
  const files = [
    './App.jsx',
    './components/PositionControls.jsx',
    './components/PositionResult.jsx',
    './components/RecoveryView.jsx',
    './components/ScenarioTable.jsx',
    './components/SettingsDeck.jsx',
    './components/ThemeToggle.jsx',
  ];
  return (await Promise.all(files.map(read))).join('\n');
};

test('React shell exposes the complete calculator navigation and accessibility contract', async () => {
  const app = await readUi();

  assert.match(app, /<h1>/);
  assert.match(app, /aria-label="Переключить цветовую тему"/);
  assert.match(app, /aria-live="polite"/);
  assert.match(app, /Калькулятор позиции/);
  assert.match(app, /Лестница восстановления/);
  assert.match(app, /Сценарии одного цикла/);
});

test('all controls from the original calculator are represented in React', async () => {
  const app = await readUi();
  const requiredFields = [
    'instrument',
    'entryPrice',
    'fpDirection',
    'slPct',
    'stage',
    'accountPreset',
    'p1Target',
    'p2Target',
    'maxDrawdown',
    'riskPerTrade',
    'rrRatio',
    'profitSplit',
    'fundedRisk',
    'bybitP1',
    'bybitP2',
    'bybitFunded',
    'fundedPayout',
    'bybitTakeProfit',
    'multiplier',
    'fpBybitRatio',
    'steps',
    'widenFrom',
    'rangeMultiplier',
  ];

  for (const field of requiredFields) assert.match(app, new RegExp(field));
});

test('funded payout defaults to the recommended 8% break-even target', async () => {
  const app = await read('./App.jsx');

  assert.match(app, /fundedPayout:\s*8/);
});

test('visual system has platform identity, a lighter dark theme, and mobile rules', async () => {
  const styles = await read('./styles.css');

  assert.match(styles, /--color-canvas:\s*#252b33/);
  assert.match(styles, /--platform-bybit/);
  assert.match(styles, /--platform-fp/);
  assert.match(styles, /\.platform-leg--bybit/);
  assert.match(styles, /\.platform-leg--fp/);
  assert.match(styles, /@media \(max-width: 720px\)/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});

test('position workspace exposes dynamic break-even and strategy optimization', async () => {
  const app = await read('./App.jsx');
  const riskRail = await read('./components/RiskRail.jsx');

  assert.match(app, /calculateBreakEven/);
  assert.match(app, /buildStrategyPresets/);
  assert.match(app, /optimizeStrategy/);
  assert.match(app, /<StrategyLab/);
  assert.match(riskRail, /Безубыток/);
  assert.match(riskRail, /Текущая цель/);
  assert.match(riskRail, /Запас/);
});

test('mobile quick mode keeps execution data and moves analytics into a drawer', async () => {
  const app = await read('./App.jsx');
  const result = await read('./components/PositionResult.jsx');
  const styles = await read('./styles.css');

  assert.match(app, /mobileAdvancedOpen/);
  assert.match(app, /aria-expanded=/);
  assert.match(app, /Расширенные настройки/);
  assert.match(result, /Копировать сделку/);
  assert.match(result, /buildTradeTicket/);
  assert.match(styles, /\.mobile-advanced-toggle/);
  assert.match(styles, /\.advanced-content/);
  assert.match(styles, /\.workspace:not\(\.advanced-open\)/);
});

test('position workspace exposes accessible Bybit live price synchronization', async () => {
  const app = await read('./App.jsx');
  const controls = await read('./components/PositionControls.jsx');

  assert.match(app, /useLivePrice/);
  assert.match(controls, /Автосинхронизация цены/);
  assert.match(controls, /aria-live="polite"/);
  assert.match(controls, /Bybit TradFi/);
});
