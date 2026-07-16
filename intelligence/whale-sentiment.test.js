import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWhaleSentiment } from './whale-sentiment.js';

const NOW = 1784194000000;

const wallet = (index, side, value, entryPrice, updatedAt = NOW - 30_000) => ({
  address: `0x${String(index).padStart(40, '0')}`,
  status: 'ACTIVE_COHORT',
  positionSide: side,
  positionSize: value / entryPrice,
  positionEntryPrice: entryPrice,
  positionValue: value,
  positionUpdatedAt: updatedAt,
  score: {
    episodeCount: 40,
    overallScore: 0.75,
    longQuality: 0.7,
    shortQuality: 0.8,
  },
  memberships: [{ cohort: `WHALE_CONVICTION_${side}`, score: 0.8 }],
});

test('whale sentiment remains warming without three qualified wallets', () => {
  const result = buildWhaleSentiment({
    wallets: [
      wallet(1, 'SHORT', 100_000, 4030),
      wallet(2, 'LONG', 50_000, 4032),
    ],
    positionSamples: [],
    maturity: 0.5,
    now: NOW,
  });

  assert.equal(result.status, 'warming');
  assert.equal(result.score, null);
  assert.equal(result.qualifiedCount, 2);
  assert.equal(JSON.stringify(result).includes('0x'), false);
});

test('whale sentiment aggregates directional pressure without exposing wallets', () => {
  const wallets = [
    wallet(1, 'SHORT', 300_000, 4030),
    wallet(2, 'SHORT', 250_000, 4031),
    wallet(3, 'SHORT', 200_000, 4032),
    wallet(4, 'LONG', 50_000, 4035),
  ];
  const positionSamples = wallets.flatMap((item, index) => [
    {
      address: item.address,
      timestamp: NOW - 60 * 60 * 1_000,
      side: index === 3 ? 'FLAT' : item.positionSide,
      size: index === 3 ? 0 : item.positionSize * 0.5,
      entryPrice: item.positionEntryPrice,
      positionValue: index === 3 ? 0 : item.positionValue * 0.5,
    },
    {
      address: item.address,
      timestamp: NOW - 15 * 60 * 1_000,
      side: index === 3 ? 'LONG' : item.positionSide,
      size: item.positionSize,
      entryPrice: item.positionEntryPrice,
      positionValue: item.positionValue,
    },
  ]);

  const result = buildWhaleSentiment({
    wallets,
    positionSamples,
    maturity: 0.7,
    now: NOW,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.direction, 'SHORT');
  assert.ok(result.score <= -35);
  assert.equal(result.qualifiedCount, 4);
  assert.equal(result.newPositions15m.short, 0);
  assert.equal(result.newPositions15m.long, 1);
  assert.ok(result.netPositionChange1h < 0);
  assert.ok(result.entryCluster.p25 >= 4030);
  assert.ok(result.entryCluster.p75 <= 4035);
  assert.equal(JSON.stringify(result).includes('address'), false);
  assert.equal(JSON.stringify(result).includes('0x'), false);
});
