import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTradeTicket } from './tradeTicket.js';

test('trade ticket contains both opposing legs with explicit TP and SL', () => {
  const ticket = buildTradeTicket({
    status: 'ready',
    stage: 'Phase 1',
    decimals: 5,
    bybit: {
      direction: 'SHORT',
      lots: 0.09,
      takeProfit: 1.33022,
      stopLoss: 1.33856,
    },
    fundingPips: {
      direction: 'LONG',
      lots: 0.72,
      takeProfit: 1.33856,
      stopLoss: 1.33022,
    },
  }, 'GBPUSD');

  assert.equal(ticket, [
    'CalcPro · GBPUSD · Phase 1',
    '',
    'BYBIT · SHORT',
    'Lots: 0.09',
    'TP: 1.33022',
    'SL: 1.33856',
    '',
    'FUNDINGPIPS · LONG',
    'Lots: 0.72',
    'TP: 1.33856',
    'SL: 1.33022',
  ].join('\n'));
});

test('trade ticket is empty while the position is invalid', () => {
  assert.equal(buildTradeTicket({ status: 'invalid' }, 'GBPUSD'), '');
});
