import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculatePosition,
  calculateRecovery,
  calculateScenarios,
  getAccountSettings,
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
