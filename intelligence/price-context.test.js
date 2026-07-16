import assert from 'node:assert/strict';
import test from 'node:test';

import { createDecisionPriceTracker } from './price-context.js';

test('decision reference ignores a single exact-price spike while execution stays exact', () => {
  let clock = 1784194000000;
  const tracker = createDecisionPriceTracker({ now: () => clock });

  for (let second = 0; second < 5; second += 1) {
    clock += 1_000;
    tracker.update({ price: 4_000, timestamp: clock });
  }
  const before = tracker.snapshot();
  assert.equal(before.executionPrice, 4_000);
  assert.equal(before.decisionReferencePrice, 4_000);

  clock += 1_000;
  tracker.update({ price: 4_100, timestamp: clock });
  const spike = tracker.snapshot();
  assert.equal(spike.executionPrice, 4_100);
  assert.equal(spike.decisionReferencePrice, 4_000);
  assert.equal(spike.mode, 'NORMAL');

  clock += 1_000;
  tracker.update({ price: 4_001, timestamp: clock });
  const recovered = tracker.snapshot();
  assert.equal(recovered.executionPrice, 4_001);
  assert.ok(recovered.decisionReferencePrice < 4_001);
  assert.ok(recovered.decisionReferencePrice >= 4_000);
});

test('persistent divergence activates fast reference convergence without jumping exactly', () => {
  let clock = 1784194000000;
  const tracker = createDecisionPriceTracker({ now: () => clock });
  for (let second = 0; second < 5; second += 1) {
    clock += 1_000;
    tracker.update({ price: 4_000, timestamp: clock });
  }

  for (let second = 0; second < 12; second += 1) {
    clock += 1_000;
    tracker.update({ price: 4_020, timestamp: clock });
  }
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.executionPrice, 4_020);
  assert.equal(snapshot.mode, 'FAST');
  assert.ok(snapshot.decisionReferencePrice > 4_000);
  assert.ok(snapshot.decisionReferencePrice < 4_020);
  assert.ok(snapshot.deviationPct > 0);
});

test('same-second quote updates exact execution without oversampling the reference', () => {
  let clock = 1784194000000;
  const tracker = createDecisionPriceTracker({ now: () => clock });
  tracker.update({ price: 4_000, timestamp: clock });
  tracker.update({ price: 4_001, timestamp: clock + 100 });
  tracker.update({ price: 4_002, timestamp: clock + 200 });

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.executionPrice, 4_002);
  assert.equal(snapshot.sampleCount, 1);
});
