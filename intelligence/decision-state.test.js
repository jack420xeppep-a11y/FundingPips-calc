import assert from 'node:assert/strict';
import test from 'node:test';

import { createDecisionStateMachine } from './decision-state.js';

const START = 1784194000000;

const input = ({
  timestamp,
  recommendation = 'short',
  maturity = 0,
  confidence = 0.7,
  longTarget = 0.35,
  longOpposite = 0.55,
  shortTarget = 0.68,
  shortOpposite = 0.22,
  neither = 0.1,
  status = 'ready',
  emergencyAligned = false,
} = {}) => ({
  timestamp,
  status,
  maturity,
  confidence,
  recommendation,
  candidates: {
    long: {
      probabilities: {
        down: longTarget,
        up: longOpposite,
        neither,
      },
    },
    short: {
      probabilities: {
        down: shortOpposite,
        up: shortTarget,
        neither,
      },
    },
  },
  sentiment: {
    market: { status: 'ready', direction: 'LONG', score: 61 },
    whale: { status: 'warming', direction: 'NEUTRAL', score: null },
    combined: { status: 'ready', direction: 'LONG', score: 61 },
  },
  priceContext: {
    executionPrice: 4035,
    decisionReferencePrice: 4034.5,
  },
  reasons: ['bounded test evidence'],
  emergencyAligned,
});

const advance = (machine, {
  start = START,
  count,
  overrides = {},
} = {}) => {
  let result;
  for (let index = 0; index < count; index += 1) {
    result = machine.update(input({
      timestamp: start + (index * 15_000),
      ...overrides,
    }));
  }
  return result;
};

test('market-only AUTO requires strong evidence and at least two minutes', () => {
  const machine = createDecisionStateMachine();
  const before = advance(machine, { count: 8 });
  assert.equal(before.decision.autoEligible, false);
  assert.equal(before.decision.state, 'WARMING');

  const confirmed = machine.update(input({ timestamp: START + 120_000 }));
  assert.equal(confirmed.decision.fpDirection, 'short');
  assert.equal(confirmed.decision.bybitDirection, 'LONG');
  assert.equal(confirmed.decision.autoEligible, true);
  assert.equal(confirmed.decision.state, 'COOLDOWN_SHORT');
  assert.equal(confirmed.decision.outcomeAnchorPrice, 4035);
  assert.equal(confirmed.decision.paths.up.label, 'BB TP / FP SL');
  assert.equal(confirmed.decision.paths.down.label, 'BB SL / FP TP');
});

test('weak immature 51 percent signal never enables AUTO', () => {
  const machine = createDecisionStateMachine();
  const result = advance(machine, {
    count: 20,
    overrides: {
      confidence: 0.39,
      longTarget: 0.4,
      longOpposite: 0.51,
      shortTarget: 0.51,
      shortOpposite: 0.4,
    },
  });

  assert.equal(result.decision.autoEligible, false);
  assert.notEqual(result.decision.state, 'CONFIRMED_SHORT');
  assert.notEqual(result.decision.state, 'COOLDOWN_SHORT');
});

test('deterministic probability jitter cannot flip a confirmed direction', () => {
  const machine = createDecisionStateMachine();
  advance(machine, { count: 9 });

  let result;
  for (let index = 9; index < 45; index += 1) {
    const jitter = [0.48, 0.5, 0.53, 0.49][index % 4];
    result = machine.update(input({
      timestamp: START + (index * 15_000),
      recommendation: 'long',
      longTarget: jitter,
      longOpposite: 0.9 - jitter,
      shortTarget: [0.62, 0.64, 0.66][index % 3],
      shortOpposite: 0.24,
    }));
  }

  assert.equal(result.decision.fpDirection, 'short');
  assert.equal(result.decision.autoEligible, true);
});

test('normal reversal needs cooldown, twenty-point edge, and 120 seconds persistence', () => {
  const machine = createDecisionStateMachine();
  advance(machine, { count: 9 });

  let result;
  for (let index = 9; index < 48; index += 1) {
    result = machine.update(input({
      timestamp: START + (index * 15_000),
      recommendation: 'long',
      longTarget: 0.72,
      longOpposite: 0.18,
      shortTarget: 0.25,
      shortOpposite: 0.65,
    }));
  }
  assert.equal(result.decision.fpDirection, 'short');

  for (let index = 48; index <= 56; index += 1) {
    result = machine.update(input({
      timestamp: START + (index * 15_000),
      recommendation: 'long',
      longTarget: 0.72,
      longOpposite: 0.18,
      shortTarget: 0.25,
      shortOpposite: 0.65,
    }));
  }
  assert.equal(result.decision.fpDirection, 'long');
  assert.equal(result.decision.state, 'COOLDOWN_LONG');
});

test('aligned emergency evidence can override cooldown after 30 seconds', () => {
  const machine = createDecisionStateMachine();
  advance(machine, { count: 9 });

  let result;
  for (let index = 9; index <= 11; index += 1) {
    result = machine.update(input({
      timestamp: START + (index * 15_000),
      recommendation: 'long',
      confidence: 0.8,
      longTarget: 0.8,
      longOpposite: 0.1,
      shortTarget: 0.2,
      shortOpposite: 0.7,
      emergencyAligned: true,
    }));
  }

  assert.equal(result.decision.fpDirection, 'long');
  assert.equal(result.decision.transitionReason, 'EMERGENCY');
});

test('lock freezes the complete decision until explicit unlock', () => {
  const machine = createDecisionStateMachine();
  const confirmed = advance(machine, { count: 9 }).decision;
  const locked = machine.lock();
  assert.equal(locked.state, 'LOCKED_SHORT');

  const changed = machine.update(input({
    timestamp: START + 300_000,
    recommendation: 'long',
    longTarget: 0.9,
    longOpposite: 0.05,
    neither: 0.05,
  }));
  assert.deepEqual(changed.decision, locked);

  const unlocked = machine.unlock(START + 315_000);
  assert.equal(unlocked.state, 'WARMING');
  assert.equal(unlocked.autoEligible, false);
  assert.equal(unlocked.fpDirection, null);
});
