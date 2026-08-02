import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');
const readUi = async () => {
  const files = [
    './App.jsx',
    './components/PositionControls.jsx',
    './components/PhaseCheckpoint.jsx',
    './components/PhaseHistory.jsx',
    './components/ActiveStrategyBar.jsx',
    './components/IntelligencePanel.jsx',
    './components/IntelligenceStrip.jsx',
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
    'accountModel',
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

test('position workspace exposes a compact phase day ledger with explicit SL and TP amounts', async () => {
  const app = await read('./App.jsx');
  const controls = await read('./components/PositionControls.jsx');
  const checkpoint = await read('./components/PhaseCheckpoint.jsx');
  const history = await read('./components/PhaseHistory.jsx');
  const styles = await read('./styles.css');

  assert.match(controls, /2 STEP STANDARD/);
  assert.match(controls, /2 STEP FLEX/);
  assert.match(app, /calculatePhaseCheckpoint/);
  assert.match(app, /updatePhaseLedger/);
  assert.match(app, /<PhaseCheckpoint/);
  assert.match(checkpoint, /День этапа/);
  assert.match(checkpoint, /SL \/ убыток/);
  assert.match(checkpoint, /TP \/ прибыль/);
  assert.match(checkpoint, /Итог дня, \$/);
  assert.doesNotMatch(checkpoint, /Итог Bybit, \$/);
  assert.match(checkpoint, /Bybit по схеме/);
  assert.match(checkpoint, /challengeCost/);
  assert.match(checkpoint, /Цена пропа, \$/);
  assert.match(checkpoint, /Куплен со скидкой/);
  assert.match(checkpoint, /Скидка покупки, %/);
  assert.match(checkpoint, /SL по схеме дня/);
  assert.match(checkpoint, /Рекомендуемый TP/);
  assert.match(checkpoint, /Правила и подсказки/);
  assert.match(checkpoint, /60% Profit Concentration/);
  assert.match(checkpoint, /Записать день/);
  assert.match(checkpoint, /<PhaseHistory/);
  assert.match(history, /История дней/);
  assert.match(history, /Эффект Bybit/);
  assert.match(history, /Цена пропа/);
  assert.match(history, /Чистыми/);
  assert.match(checkpoint, /onRecord/);
  assert.match(checkpoint, /До цели/);
  assert.match(checkpoint, /Запас до общего лимита/);
  assert.match(styles, /\.phase-checkpoint/);
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

test('gold workspace exposes safe HL Intelligence AUTO guidance and setup lock', async () => {
  const app = await read('./App.jsx');
  const controls = await read('./components/PositionControls.jsx');
  const panel = await read('./components/IntelligencePanel.jsx');
  const result = await read('./components/PositionResult.jsx');
  const styles = await read('./styles.css');

  assert.match(app, /useGoldIntelligence/);
  assert.match(app, /tradeSnapshot/);
  assert.match(app, /persistTradeSnapshot/);
  assert.match(controls, /HL Intelligence/);
  assert.match(controls, /OFF/);
  assert.match(controls, /AUTO/);
  assert.match(panel, /path\?\.label/);
  assert.match(panel, /Уверенность/);
  assert.match(panel, /Зрелость модели/);
  assert.match(panel, /Qualified whales/);
  assert.match(panel, /Market sentiment/);
  assert.match(panel, /Whale sentiment/);
  assert.match(panel, /NEXT SWITCH EARLIEST/);
  assert.match(panel, /Разблокировать AUTO/);
  assert.match(panel, /Зафиксировать сделку/);
  assert.match(result, /prepareTradeCopy/);
  assert.match(result, /MARKET NOW/);
  assert.match(styles, /\.intelligence-panel/);
  assert.match(styles, /\.intelligence-paths/);
  assert.match(styles, /\.sentiment-brief/);
  assert.match(styles, /\.pressure-row/);
  assert.match(styles, /\.intelligence-inline/);
});

test('execution stays ahead of detailed intelligence and exposes a compact decision strip', async () => {
  const app = await read('./App.jsx');
  const strip = [
    await read('./components/IntelligenceStrip.jsx'),
    await read('./components/intelligence-strip-view.js'),
  ].join('\n');
  const styles = await read('./styles.css');

  assert.match(app, /<IntelligenceStrip/);
  assert.match(app, /<details className="intelligence-disclosure"/);
  assert.ok(
    app.indexOf('<PositionResult') < app.indexOf('<IntelligencePanel'),
    'execution result must render before detailed intelligence',
  );
  assert.match(strip, /HL AUTO/);
  assert.match(strip, /BIAS/);
  assert.match(strip, /DOWN/);
  assert.match(strip, /UP/);
  assert.match(strip, /NEITHER/);
  assert.match(strip, /CONFIRMED/);
  assert.match(strip, /stableForMs/);
  assert.match(styles, /\.intelligence-strip/);
  assert.match(styles, /\.intelligence-disclosure/);
});

test('mobile execution has a sticky readiness checklist and lock-copy action', async () => {
  const result = await read('./components/PositionResult.jsx');
  const styles = await read('./styles.css');

  assert.match(result, /QUOTE LIVE/);
  assert.match(result, /RISK OK/);
  assert.match(result, /DIRECTION LOCKED/);
  assert.match(result, /TP\/SL READY/);
  assert.match(result, /Зафиксировать и скопировать/);
  assert.match(styles, /\.execution-readiness/);
  assert.match(styles, /\.quick-actions[\s\S]*position:\s*(?:sticky|fixed)/);
});

test('strategy comparison exposes active profile, trade-offs, and mobile cards', async () => {
  const app = await read('./App.jsx');
  const activeProfile = await read('./components/ActiveStrategyBar.jsx');
  const strategyLab = await read('./components/StrategyLab.jsx');
  const styles = await read('./styles.css');

  assert.match(app, /<ActiveStrategyBar/);
  assert.match(activeProfile, /ACTIVE PROFILE/);
  assert.match(activeProfile, /P1/);
  assert.match(activeProfile, /P2/);
  assert.match(activeProfile, /Funded/);
  assert.match(activeProfile, /payout/);
  assert.match(strategyLab, /strategy-tradeoffs/);
  assert.match(strategyLab, /strategy-cards/);
  assert.match(strategyLab, /aria-pressed=/);
  assert.match(styles, /\.strategy-cards/);
  assert.match(styles, /\.strategy-card\.is-active/);
});
