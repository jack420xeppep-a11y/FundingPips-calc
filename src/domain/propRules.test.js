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

test('recorded day history keeps prior FP results and their mirrored Bybit effect', () => {
  let ledger = createEmptyPhaseLedger();
  ledger = updatePhaseLedger(ledger, 'p1', 1, {
    outcome: 'sl',
    amount: 1_000,
    bybitStake: 63,
    bybitLoss: 126,
  });
  ledger = updatePhaseLedger(ledger, 'p1', 2, {
    outcome: 'tp',
    amount: 3_500,
    bybitStake: 63,
    bybitLoss: 126,
  });

  const checkpoint = calculatePhaseCheckpoint({
    accountModel: 'flex',
    accountSize: 25_000,
    stage: 'p1',
    selectedDay: 2,
    ledger,
    profitSplit: 0.85,
    bybitStake: 99,
    bybitLoss: 198,
  });

  assert.deepEqual(checkpoint.recordedDays, [
    {
      day: 1,
      outcome: 'sl',
      fpPnl: -1_000,
      bybitOutcome: 'tp',
      bybitPnl: 63,
    },
    {
      day: 2,
      outcome: 'tp',
      fpPnl: 3_500,
      bybitOutcome: 'sl',
      bybitPnl: -126,
    },
  ]);
  assert.equal(checkpoint.bybitPnl, -63);
});

test('prop purchase price affects cash result without changing FundingPips limits', () => {
  let ledger = createEmptyPhaseLedger();
  ledger = updatePhaseLedger(ledger, 'p1', 1, {
    outcome: 'sl', amount: 385, bybitStake: 25,
  });
  ledger = updatePhaseLedger(ledger, 'p1', 2, {
    outcome: 'sl', amount: 480, bybitStake: 25,
  });
  ledger = updatePhaseLedger(ledger, 'p1', 3, {
    outcome: 'sl', amount: 135, bybitStake: 25,
  });

  const checkpoint = calculatePhaseCheckpoint({
    accountModel: 'standard',
    accountSize: 10_000,
    stage: 'p1',
    selectedDay: 3,
    ledger,
    profitSplit: 0.8,
    bybitStake: 25,
    challengeCost: 66,
  });

  assert.equal(checkpoint.realizedPnl, -1_000);
  assert.equal(checkpoint.maxLossBreach, true);
  assert.equal(checkpoint.bybitPnl, 75);
  assert.equal(checkpoint.propCost, 66);
  assert.equal(checkpoint.netCashResult, 9);

  ledger = updatePhaseLedger(ledger, 'p2', 1, {
    outcome: 'tp', amount: 500, bybitStake: 45, bybitLoss: 90,
  });
  const phaseTwo = calculatePhaseCheckpoint({
    accountModel: 'standard',
    accountSize: 10_000,
    stage: 'p2',
    selectedDay: 1,
    ledger,
    profitSplit: 0.8,
    bybitStake: 45,
    bybitLoss: 90,
    challengeCost: 66,
  });

  assert.equal(phaseTwo.bybitPnl, -15);
  assert.equal(phaseTwo.netCashResult, -81);
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
