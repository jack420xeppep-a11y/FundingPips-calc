import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculatePhaseEconomics,
  calculatePosition,
  calculateRecovery,
  calculateScenarios,
  getAccountSettings,
  getLegacyAccountSettings,
} from './calculator.js';

test('account preset scales Bybit stakes from the selected risk', () => {
  assert.deepEqual(getAccountSettings('25k', 1, 0.5), {
    accountSize: 25000,
    challengeCost: 156,
    bybitP1: 31.5,
    bybitP2: 56.5,
    bybitFunded: 56.5,
  });
});

test('legacy account preset preserves the original calculator stakes', () => {
  assert.deepEqual(getLegacyAccountSettings('10k', 2, 1), {
    accountSize: 10000,
    challengeCost: 66,
    bybitP1: 25,
    bybitP2: 55,
    bybitFunded: 50,
  });
  assert.deepEqual(getLegacyAccountSettings('25k', 1, 0.5), {
    accountSize: 25000,
    challengeCost: 156,
    bybitP1: 31.5,
    bybitP2: 69,
    bybitFunded: 62.5,
  });
});

test('recommended 10k preset reaches break-even near an 8% funded payout', () => {
  const preset = getAccountSettings('10k', 2, 1);

  assert.deepEqual(preset, {
    accountSize: 10000,
    challengeCost: 66,
    bybitP1: 25,
    bybitP2: 45,
    bybitFunded: 45,
  });

  const scenarios = calculateScenarios({
    ...preset,
    p1Target: 8,
    p2Target: 5,
    maxDrawdown: 10,
    riskPerTrade: 2,
    profitSplit: 0.8,
    fundedRisk: 1,
    fundedPayout: 8,
  });

  assert.deepEqual(scenarios.map((scenario) => scenario.total), [59, 59, 171.5, 1.5]);
});

test('position sizing produces opposing legs with explicit TP and SL', () => {
  const result = calculatePosition({
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    fpDirection: 'long',
    slPct: 0.22,
    stage: 'p1',
    rrRatio: 2,
    accountSize: 10000,
    riskPerTrade: 2,
    fundedRisk: 1,
    bybitP1: 25,
    bybitP2: 55,
    bybitFunded: 50,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.bybit.direction, 'SHORT');
  assert.equal(result.fundingPips.direction, 'LONG');
  assert.equal(result.bybit.lots, 0.09);
  assert.equal(result.fundingPips.lots, 0.72);
  assert.equal(result.bybit.takeProfit, 1.33022);
  assert.equal(result.bybit.stopLoss, 1.33856);
  assert.equal(result.fundingPips.takeProfit, 1.33856);
  assert.equal(result.fundingPips.stopLoss, 1.33022);
  assert.equal(result.actualSlPct, 0.208);
});

test('position sizing rejects zero or missing market inputs', () => {
  const result = calculatePosition({
    instrument: 'GBPUSD',
    entryPrice: 0,
    slPct: 0.22,
  });

  assert.equal(result.status, 'invalid');
  assert.match(result.message, /цен/i);
});

test('cycle scenarios preserve the original calculator outcomes', () => {
  const scenarios = calculateScenarios({
    accountSize: 10000,
    challengeCost: 66,
    p1Target: 8,
    p2Target: 5,
    maxDrawdown: 10,
    riskPerTrade: 2,
    profitSplit: 0.8,
    fundedRisk: 1,
    bybitP1: 25,
    bybitP2: 55,
    bybitFunded: 50,
    fundedPayout: 5,
  });

  assert.deepEqual(scenarios.map((scenario) => scenario.total), [59, 109, 196.5, -153.5]);
  assert.equal(scenarios.at(-1).fundingPipsPayout, 400);
});

test('recovery ladder calculates losses, wins, and range expansion', () => {
  const result = calculateRecovery({
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    slPct: 0.075,
    rrRatio: 2,
    bybitTakeProfit: 2,
    multiplier: 1.5,
    fpBybitRatio: 8,
    steps: 4,
    widenFrom: 3,
    rangeMultiplier: 2,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[0].bybitLots, 0.02);
  assert.equal(result.rows[0].fundingPipsLots, 0.16);
  assert.equal(result.rows[0].fundingPipsLoss, 16);
  assert.equal(result.rows[2].rangeChanged, true);
  assert.equal(result.rows[2].slPct, 0.15);
});

test('fee-off inputs keep the legacy fee-free maths untouched', () => {
  const base = {
    ...getAccountSettings('25k', 2, 1),
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    slPct: 0.22,
    rrRatio: 2,
    p1Target: 8,
    p2Target: 5,
    maxDrawdown: 10,
    riskPerTrade: 2,
    profitSplit: 0.8,
    fundedRisk: 1,
    fundedPayout: 8,
  };

  const legacy = calculateScenarios(base);
  const explicitOff = calculateScenarios({
    ...base,
    feesEnabled: false,
    bybitFeePct: 0.055,
    fpCommissionPerLot: 4,
    winRate: 50,
  });

  assert.deepEqual(explicitOff, legacy);
  assert.equal(legacy.at(-1).total, 5.5);
});

test('calculatePhaseEconomics matches hand-computed fee costs', () => {
  const input = {
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    slPct: 0.22,
    rrRatio: 2,
    accountSize: 25000,
    feesEnabled: true,
    bybitFeePct: 0.055,
    fpCommissionPerLot: 0,
    winRate: 50,
  };

  // progress per trade = 2 × (0.5 × 3 − 1) = 1% → 8 trades to +8%
  const econ = calculatePhaseEconomics(input, 8, 2, 63);
  assert.equal(econ.status, 'ready');
  assert.equal(econ.trades, 8);
  // stake cost stays units × stake without FP commission
  assert.equal(econ.stakeCost, 252);
  // per-trade Bybit fee = 63 × 2×0.055 / 0.22 = $31.5 → ×8 = $252
  assert.equal(econ.feeCost, 252);
  assert.equal(econ.total, 504);
});

test('fp commission consumes progress and raises trade count', () => {
  const input = {
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    slPct: 0.22,
    rrRatio: 2,
    accountSize: 25000,
    feesEnabled: true,
    bybitFeePct: 0,
    fpCommissionPerLot: 2.933,
    winRate: 50,
  };

  // fp lots = (25000×2)/(100000×1.333×0.22) = 1.7052; commission ≈ $5.0018/trade
  // ≈ 0.02% of account → progress 0.98%/trade → более 8 сделок
  const econ = calculatePhaseEconomics(input, 8, 2, 63);
  assert.equal(econ.status, 'ready');
  assert.ok(econ.trades > 8 && econ.trades < 8.4);
  assert.ok(econ.stakeCost > 252);
});

test('unreachable progress collapses scenarios to an explicit warning', () => {
  const base = {
    ...getAccountSettings('25k', 2, 1),
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    slPct: 0.22,
    rrRatio: 0.5,
    p1Target: 8,
    p2Target: 5,
    maxDrawdown: 10,
    riskPerTrade: 2,
    profitSplit: 0.8,
    fundedRisk: 1,
    fundedPayout: 8,
    feesEnabled: true,
    bybitFeePct: 0.055,
    fpCommissionPerLot: 0,
    winRate: 50,
  };

  // winrate 50% при RR 0.5 → прогресс за сделку = 2×(0.5×1.5−1) < 0
  const scenarios = calculateScenarios(base);
  assert.equal(scenarios.at(-1).name, 'Цели недостижимы');
  assert.equal(scenarios.at(-1).total, null);
  assert.ok(scenarios.at(-1).message.length > 0);
});

test('failure recovery nets out bybit fees on the straight-loss path', () => {
  const base = {
    ...getAccountSettings('25k', 2, 1),
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    slPct: 0.22,
    rrRatio: 2,
    p1Target: 8,
    p2Target: 5,
    maxDrawdown: 10,
    riskPerTrade: 2,
    profitSplit: 0.8,
    fundedRisk: 1,
    fundedPayout: 8,
    feesEnabled: true,
    bybitFeePct: 0.055,
    fpCommissionPerLot: 0,
    winRate: 50,
  };

  const scenarios = calculateScenarios(base);
  // 5 losing trades × (63 − 31.5) = 157.5 вместо fee-free 315
  assert.equal(scenarios[0].bybitRecovery, 157.5);
  assert.equal(scenarios[0].total, 1.5);
});

test('calculatePosition exposes per-trade fees when enabled', () => {
  const result = calculatePosition({
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    fpDirection: 'long',
    slPct: 0.22,
    stage: 'p1',
    rrRatio: 2,
    riskPerTrade: 2,
    fundedRisk: 1,
    accountSize: 25000,
    bybitP1: 63,
    bybitP2: 113,
    bybitFunded: 113,
    feesEnabled: true,
    bybitFeePct: 0.055,
    fpCommissionPerLot: 4,
    winRate: 50,
  });

  assert.equal(result.status, 'ready');
  assert.ok(result.fees.bybit > 25 && result.fees.bybit < 35);
  assert.ok(result.fees.fundingPips > 6 && result.fees.fundingPips < 8);

  const feeFree = calculatePosition({
    instrument: 'GBPUSD',
    entryPrice: 1.333,
    fpDirection: 'long',
    slPct: 0.22,
    stage: 'p1',
    rrRatio: 2,
    riskPerTrade: 2,
    fundedRisk: 1,
    accountSize: 25000,
    bybitP1: 63,
    bybitP2: 113,
    bybitFunded: 113,
  });
  assert.equal(feeFree.fees, null);
  assert.equal(feeFree.bybit.lots, result.bybit.lots);
});
