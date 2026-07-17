import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIntelligenceStripView,
  formatProbability,
} from './components/intelligence-strip-view.js';

test('WATCH keeps the directional bias and all three forecasts visible without enabling AUTO', () => {
  const view = buildIntelligenceStripView({
    liveSnapshot: {
      generatedAt: 2_000,
      recommendation: {
        fpDirection: 'short',
        autoEligible: false,
      },
      decision: {
        state: 'WATCH_SHORT',
        fpDirection: 'short',
        autoEligible: false,
        confidence: 0.35,
        generatedAt: 2_000,
        stableSince: 1_000,
        paths: {
          down: { probability: 0.2 },
          up: { probability: 0.51 },
          neither: { probability: 0.29 },
        },
      },
    },
  });

  assert.equal(view.actionable, false);
  assert.equal(view.directionMode, 'BIAS');
  assert.equal(view.directionText, 'FP SHORT / BB LONG');
  assert.equal(view.stateLabel, 'WATCH');
  assert.deepEqual(view.paths, [
    { key: 'down', label: 'DOWN', probability: 0.2, primary: false },
    { key: 'up', label: 'UP', probability: 0.51, primary: true },
    { key: 'neither', label: 'NEITHER', probability: 0.29, primary: false },
  ]);
});

test('missing path probability is not presented as a fabricated zero', () => {
  const view = buildIntelligenceStripView({
    liveSnapshot: {
      decision: {
        paths: {
          down: { probability: null },
          up: {},
          neither: {},
        },
      },
    },
  });

  assert.equal(view.paths[0].probability, null);
  assert.equal(formatProbability(null), '—');
  assert.equal(formatProbability(undefined), '—');
  assert.equal(formatProbability(0), '0%');
});
