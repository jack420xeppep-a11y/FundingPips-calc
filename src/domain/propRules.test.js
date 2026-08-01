import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculatePhaseCheckpoint,
  createEmptyPhaseLedger,
  getPropModelPreset,
  getPropRules,
  updatePhaseLedger,
} from './propRules.js';

test('official Standard and Flex presets expose their current FundingPips limits', () => {
  assert.deepEqual(getPropModelPreset('standard'), {
    accountModel: 'standard',
    p1Target: 8,
    p2Target: 5,
    dailyLossLimit: 5,
    maxDrawdown: 10,
    profitSplit: 0.8,
  });
  assert.deepEqual(getPropModelPreset('flex'), {
    accountModel: 'flex',
    p1Target: 10,
    p2Target: 6,
    dailyLossLimit: 4,
    maxDrawdown: 12,
    profitSplit: 0.85,
  });
});

test('25K Flex rules calculate phase targets, concentration and Master idea limits', () => {
  const phaseOne = getPropRules({
    accountModel: 'flex',
    accountSize: 25_000,
    stage: 'p1',
    profitSplit: 0.85,
    fundedPayout: 8,
  });
  const master = getPropRules({
    accountModel: 'flex',
    accountSize: 25_000,
    stage: 'funded',
    profitSplit: 0.85,
    fundedPayout: 8,
  });

  assert.equal(phaseOne.targetPct, 10);
  assert.equal(phaseOne.targetAmount, 2_500);
  assert.equal(phaseOne.dailyLossAmount, 1_000);
  assert.equal(phaseOne.maxLossAmount, 3_000);
  assert.equal(phaseOne.concentrationThreshold, 1_500);
  assert.equal(phaseOne.tradeIdeaLimitAmount, null);
  assert.equal(master.tradeIdeaLimitPct, 3);
  assert.equal(master.tradeIdeaLimitAmount, 750);
});

test('Standard requires three trading days while Flex 95 requires three profitable days', () => {
  const standard = getPropRules({
    accountModel: 'standard',
    accountSize: 25_000,
    stage: 'p1',
    profitSplit: 0.8,
  });
  const flex85 = getPropRules({
    accountModel: 'flex',
    accountSize: 25_000,
    stage: 'p1',
    profitSplit: 0.85,
  });
  const flex95 = getPropRules({
    accountModel: 'flex',
    accountSize: 25_000,
    stage: 'p1',
    profitSplit: 0.95,
  });

  assert.equal(standard.requiredTradingDays, 3);
  assert.equal(standard.requiredProfitableDays, 0);
  assert.equal(flex85.requiredTradingDays, 0);
  assert.equal(flex85.requiredProfitableDays, 0);
  assert.equal(flex95.requiredTradingDays, 0);
  assert.equal(flex95.requiredProfitableDays, 3);
});

test('phase ledger preserves each selected day and calculates the illustrated SL then TP path', () => {
  let ledger = createEmptyPhaseLedger();
  ledger = updatePhaseLedger(ledger, 'p1', 1, { outcome: 'sl', amount: 1_000 });
  ledger = updatePhaseLedger(ledger, 'p1', 2, { outcome: 'tp', amount: 3_000 });

  const checkpoint = calculatePhaseCheckpoint({
    accountModel: 'standard',
    accountSize: 25_000,
    stage: 'p1',
    selectedDay: 2,
    ledger,
    profitSplit: 0.8,
  });

  assert.equal(checkpoint.realizedPnl, 2_000);
  assert.equal(checkpoint.targetAmount, 2_000);
  assert.equal(checkpoint.remainingToTarget, 0);
  assert.equal(checkpoint.tradingDays, 2);
  assert.equal(checkpoint.status, 'target_reached_days_pending');
  assert.equal(checkpoint.dayOpeningBalance, 24_000);
  assert.equal(checkpoint.selectedDayLossLimit, 1_200);
});

test('checkpoint identifies a hard loss breach and a separate 60% concentration warning', () => {
  let lossLedger = createEmptyPhaseLedger();
  lossLedger = updatePhaseLedger(lossLedger, 'p1', 1, { outcome: 'sl', amount: 3_000 });
  const breached = calculatePhaseCheckpoint({
    accountModel: 'flex',
    accountSize: 25_000,
    stage: 'p1',
    selectedDay: 1,
    ledger: lossLedger,
    profitSplit: 0.85,
  });

  assert.equal(breached.status, 'breached');
  assert.equal(breached.dailyBreach, true);
  assert.equal(breached.maxLossBreach, true);

  let profitLedger = createEmptyPhaseLedger();
  profitLedger = updatePhaseLedger(profitLedger, 'p2', 1, { outcome: 'tp', amount: 901 });
  const concentrated = calculatePhaseCheckpoint({
    accountModel: 'flex',
    accountSize: 25_000,
    stage: 'p2',
    selectedDay: 1,
    ledger: profitLedger,
    profitSplit: 0.85,
  });

  assert.equal(concentrated.concentrationThreshold, 900);
  assert.equal(concentrated.concentrationTriggered, true);
  assert.equal(concentrated.status, 'tracking');
});
