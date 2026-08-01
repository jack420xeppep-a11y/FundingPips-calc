import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPhaseLedgerKey,
  readPhaseLedgers,
  writePhaseLedgers,
} from './phaseLedgerStorage.js';

test('phase histories persist separately for each model and account size', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  };
  const histories = {
    'flex:25k': { p1: [{ outcome: 'sl', amount: 1_000, bybitStake: 63 }] },
    'standard:10k': { p1: [{ outcome: 'tp', amount: 800, bybitStake: 25 }] },
  };

  writePhaseLedgers(histories, storage);

  assert.equal(buildPhaseLedgerKey('flex', '25k'), 'flex:25k');
  assert.deepEqual(readPhaseLedgers(storage), histories);
});

test('malformed saved history falls back to an empty collection', () => {
  const storage = { getItem: () => '{broken' };

  assert.deepEqual(readPhaseLedgers(storage), {});
});
