import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculatePhaseCheckpoint,
  createEmptyPhaseLedger,
  getPropModelPreset,
  getPropRules,
  getResetOffer,
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

test('Standard scheme calculates illustrated Bybit outcomes without manual daily input', () => {
  let ledger = createEmptyPhaseLedger();
  ledger = updatePhaseLedger(ledger, 'p1', 1, {
    outcome: 'sl', amount: 385, bybitStake: 25, bybitAmount: 999,
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
  assert.equal(checkpoint.bybitPnl, 125);
  assert.deepEqual(
    checkpoint.recordedDays.map(({ day, bybitPnl }) => ({ day, bybitPnl })),
    [
      { day: 1, bybitPnl: 50 },
      { day: 2, bybitPnl: 50 },
      { day: 3, bybitPnl: 25 },
    ],
  );
  assert.equal(checkpoint.propCost, 66);
  assert.equal(checkpoint.netCashResult, 59);

  let phaseTwoLedger = createEmptyPhaseLedger();
  phaseTwoLedger = updatePhaseLedger(phaseTwoLedger, 'p1', 1, {
    outcome: 'tp', amount: 800,
  });
  phaseTwoLedger = updatePhaseLedger(phaseTwoLedger, 'p2', 1, {
    outcome: 'sl', amount: 400,
  });
  phaseTwoLedger = updatePhaseLedger(phaseTwoLedger, 'p2', 2, {
    outcome: 'sl', amount: 400,
  });
  phaseTwoLedger = updatePhaseLedger(phaseTwoLedger, 'p2', 3, {
    outcome: 'sl', amount: 200,
  });
  const phaseTwo = calculatePhaseCheckpoint({
    accountModel: 'standard',
    accountSize: 10_000,
    stage: 'p2',
    selectedDay: 3,
    ledger: phaseTwoLedger,
    profitSplit: 0.8,
    bybitStake: 45,
    bybitLoss: 90,
    challengeCost: 66,
  });

  assert.deepEqual(
    phaseTwo.recordedDays.map(({ day, bybitPnl }) => ({ day, bybitPnl })),
    [
      { day: 1, bybitPnl: 100 },
      { day: 2, bybitPnl: 100 },
      { day: 3, bybitPnl: 50 },
    ],
  );
  assert.equal(phaseTwo.bybitPnl, 150);
  assert.equal(phaseTwo.netCashResult, 84);
});

test('reset discount is offered only after breach and does not replace original prop cost', () => {
  assert.equal(getResetOffer({ stage: 'p1', status: 'tracking', purchasePrice: 66 }), null);
  assert.deepEqual(getResetOffer({
    stage: 'p1',
    status: 'breached',
    accountSize: 10_000,
    purchasePrice: 66,
  }), {
    stage: 'p1',
    label: 'Phase 1',
    discountPct: 15,
    purchasePrice: 66,
    resetPrice: 56.1,
    restartStage: 'p1',
    expiresInDays: 7,
  });
  assert.equal(getResetOffer({
    stage: 'funded',
    status: 'breached',
    accountSize: 100_000,
    purchasePrice: 529,
  }), null);
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
