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
