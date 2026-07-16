import assert from 'node:assert/strict';
import test from 'node:test';

import { createActivePositionReconciler } from './position-reconciler.js';

const NOW = 1784194000000;

test('active position reconciliation refreshes qualified wallets without exposing identities', async () => {
  const addresses = [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222',
  ];
  const writes = [];
  const logs = [];
  const reconciler = createActivePositionReconciler({
    database: {
      listActiveWalletAddresses: () => addresses,
      recordGoldPosition(address, position, options) {
        writes.push({ address, position, options });
      },
    },
    infoClient: {
      async fetchGoldPosition(address) {
        return address === addresses[0]
          ? {
            side: 'SHORT',
            size: 2,
            entryPrice: 4030,
            positionValue: 8060,
            unrealizedPnl: 20,
          }
          : null;
      },
    },
    now: () => NOW,
    logger: (entry) => logs.push(entry),
  });

  assert.deepEqual(await reconciler.runOnce(), {
    reviewed: 2,
    updated: 2,
    failed: 0,
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.at, NOW);
  assert.equal(writes[1].position, null);
  assert.equal(JSON.stringify(logs).includes('0x'), false);
});

test('active position reconciliation isolates upstream failures', async () => {
  const reconciler = createActivePositionReconciler({
    database: {
      listActiveWalletAddresses: () => [
        '0x1111111111111111111111111111111111111111',
      ],
      recordGoldPosition() {},
    },
    infoClient: {
      async fetchGoldPosition() {
        throw new TypeError('upstream failed');
      },
    },
    now: () => NOW,
  });

  assert.deepEqual(await reconciler.runOnce(), {
    reviewed: 1,
    updated: 0,
    failed: 1,
  });
});
