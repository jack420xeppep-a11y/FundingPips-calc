import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFieldValue } from './components/fieldValue.js';

test('select preserves string option values such as XAUUSD', () => {
  const options = [
    { value: 'GBPUSD', label: 'GBPUSD' },
    { value: 'XAUUSD', label: 'XAUUSD' },
  ];

  assert.equal(normalizeFieldValue('XAUUSD', { options }), 'XAUUSD');
});

test('select preserves the declared type of numeric options', () => {
  const options = [
    { value: 0.8, label: 'Bi-Weekly — 80%' },
    { value: 1, label: 'Monthly — 100%' },
  ];

  assert.equal(normalizeFieldValue('0.8', { options }), 0.8);
});

test('number fields still convert valid input to a number', () => {
  assert.equal(normalizeFieldValue('2900.25', { type: 'number' }), 2900.25);
  assert.equal(normalizeFieldValue('', { type: 'number' }), '');
});
