import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateScenarios, getAccountSettings } from './calculator.js';
import {
  STRATEGY_GOALS,
  buildStrategyPresets,
  calculateBreakEven,
  optimizeStrategy,
} from './strategies.js';

const baseInput = {
  accountPreset: '10k',
  p1Target: 8,
  p2Target: 5,
  maxDrawdown: 10,
  riskPerTrade: 2,
  profitSplit: 0.8,
  fundedRisk: 1,
  fundedPayout: 8,
  ...getAccountSettings('10k', 2, 1),
};

test('dynamic break-even tracks the current target and its safety margin', () => {
  const result = calculateBreakEven(baseInput);

  assert.equal(result.status, 'ready');
  assert.equal(result.fixedCosts, 278.5);
  assert.equal(result.payoutPerPct, 80);
  assert.equal(result.fundedHedgePerPct, 45);
  assert.equal(result.netPerPct, 35);
  assert.equal(result.breakEvenPct, 7.9571);
  assert.equal(result.safeBreakEvenPct, 7.96);
  assert.equal(result.currentTargetPct, 8);
  assert.equal(result.marginPct, 0.04);
  assert.equal(result.projectedTotal, 1.5);
});

test('break-even is marked unreachable when funded hedge costs consume the payout', () => {
  const result = calculateBreakEven({ ...baseInput, bybitFunded: 80 });

  assert.equal(result.status, 'unreachable');
  assert.equal(result.breakEvenPct, null);
  assert.equal(result.safeBreakEvenPct, null);
  assert.equal(result.marginPct, null);
  assert.match(result.message, /ставк.*Funded/i);
});

test('prepared strategy comparison is calculated from the selected account', () => {
  const strategies = buildStrategyPresets(baseInput);

  assert.deepEqual(
    strategies.map(({ id, stakes, safeBreakEvenPct, phaseOneFailure }) => ({
      id,
      stakes,
      safeBreakEvenPct,
      phaseOneFailure,
    })),
    [
      {
        id: 'balanced',
        stakes: { bybitP1: 25, bybitP2: 45, bybitFunded: 45 },
        safeBreakEvenPct: 7.96,
        phaseOneFailure: 59,
      },
      {
        id: 'bybit-first',
        stakes: { bybitP1: 35, bybitP2: 60, bybitFunded: 55 },
        safeBreakEvenPct: 14.24,
        phaseOneFailure: 109,
      },
      {
        id: 'funded-first',
        stakes: { bybitP1: 20, bybitP2: 35, bybitFunded: 35 },
        safeBreakEvenPct: 5.19,
        phaseOneFailure: 34,
      },
    ],
  );
});

test('prepared strategy stakes stay on a fifty-cent step for larger accounts', () => {
  const input = {
    ...baseInput,
    accountPreset: '25k',
    ...getAccountSettings('25k', 2, 1),
  };
  const strategies = buildStrategyPresets(input);

  assert.deepEqual(strategies[1].stakes, {
    bybitP1: 88,
    bybitP2: 150.5,
    bybitFunded: 138,
  });
  assert.ok(
    strategies.every(({ stakes }) =>
      Object.values(stakes).every((stake) => Number.isInteger(stake * 2))),
  );
});

test('optimizer exposes all requested goals and produces deterministic stakes', () => {
  assert.deepEqual(
    STRATEGY_GOALS.map(({ id }) => id),
    ['minimum-load', 'fast-break-even', 'max-fp-failure-profit', 'minimum-funded-tp', 'balanced'],
  );

  const expected = {
    'minimum-load': { bybitP1: 13.5, bybitP2: 24, bybitFunded: 18 },
    'fast-break-even': { bybitP1: 13.5, bybitP2: 24, bybitFunded: 18 },
    'max-fp-failure-profit': { bybitP1: 35, bybitP2: 60, bybitFunded: 55 },
    'minimum-funded-tp': { bybitP1: 25, bybitP2: 45, bybitFunded: 28 },
    balanced: { bybitP1: 25, bybitP2: 45, bybitFunded: 45 },
  };

  for (const goal of STRATEGY_GOALS) {
    const result = optimizeStrategy(baseInput, goal.id);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.stakes, expected[goal.id]);

    const failureScenarios = calculateScenarios({
      ...baseInput,
      ...result.stakes,
    }).slice(0, 3);

    assert.ok(
      failureScenarios.every(({ total }) => total >= 0),
      `${goal.id} должен сохранять неотрицательный итог при сливе FP`,
    );
  }
});

test('minimum funded target keeps P1/P2 preset and reduces only Funded stake', () => {
  const result = optimizeStrategy(baseInput, 'minimum-funded-tp');

  assert.deepEqual(result.stakes, {
    bybitP1: 25,
    bybitP2: 45,
    bybitFunded: 28,
  });
  assert.equal(result.safeBreakEvenPct, 5.36);
  assert.equal(result.failureFloor, 1.5);
});
