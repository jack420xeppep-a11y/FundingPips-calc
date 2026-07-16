import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntelligenceDatabase } from './database.js';
import {
  classifyWalletBehaviour,
  reconstructTradingEpisodes,
} from './episodes.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

const fill = ({
  timestamp,
  side,
  size,
  startPosition,
  price,
  closedPnl = 0,
  crossed = false,
  tid = timestamp,
}) => ({
  address: ADDRESS,
  coin: 'xyz:GOLD',
  timestamp,
  side,
  size,
  startPosition,
  price,
  closedPnl,
  crossed,
  direction: 'test',
  hash: `0x${String(tid).padStart(64, 'a').slice(-64)}`,
  oid: tid + 100,
  fee: 0,
  tid,
});

test('episode reconstruction uses startPosition for add, reduce, and close', () => {
  const fills = [
    fill({ timestamp: 1000, side: 'B', size: 2, startPosition: 0, price: 100, crossed: true }),
    fill({ timestamp: 2000, side: 'B', size: 1, startPosition: 2, price: 110 }),
    fill({ timestamp: 3000, side: 'A', size: 1, startPosition: 3, price: 120, closedPnl: 20 }),
    fill({ timestamp: 4000, side: 'A', size: 2, startPosition: 2, price: 90, closedPnl: -20, crossed: true }),
  ];
  const marketSamples = [
    { timestamp: 1000, price: 100, regime: 'RANGE' },
    { timestamp: 2000, price: 115 },
    { timestamp: 3000, price: 85 },
    { timestamp: 4000, price: 90 },
  ];

  const [episode] = reconstructTradingEpisodes(fills, { marketSamples });
  assert.equal(episode.side, 'LONG');
  assert.equal(episode.openedAt, 1000);
  assert.equal(episode.closedAt, 4000);
  assert.equal(episode.entryPrice.toFixed(4), '103.3333');
  assert.equal(episode.exitPrice, 100);
  assert.equal(episode.peakSize, 3);
  assert.equal(episode.closedPnl, 0);
  assert.equal(episode.holdMs, 3000);
  assert.equal(episode.fillCount, 4);
  assert.equal(episode.aggressiveRatio, 0.5);
  assert.equal(episode.complete, true);
  assert.equal(episode.historyTruncated, false);
  assert.ok(episode.mfeBps > 1100);
  assert.ok(episode.maeBps < -1700);
  assert.equal(episode.regime, 'RANGE');
});

test('a crossing fill closes one episode and opens the opposite episode', () => {
  const fills = [
    fill({ timestamp: 1000, side: 'B', size: 1, startPosition: 0, price: 100 }),
    fill({ timestamp: 2000, side: 'A', size: 3, startPosition: 1, price: 110, closedPnl: 10 }),
    fill({ timestamp: 3000, side: 'B', size: 2, startPosition: -2, price: 90, closedPnl: 40 }),
  ];

  const episodes = reconstructTradingEpisodes(fills);
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes.map((episode) => ({
    side: episode.side,
    openedAt: episode.openedAt,
    closedAt: episode.closedAt,
    entryPrice: episode.entryPrice,
    exitPrice: episode.exitPrice,
    closedPnl: episode.closedPnl,
    complete: episode.complete,
  })), [
    {
      side: 'LONG',
      openedAt: 1000,
      closedAt: 2000,
      entryPrice: 100,
      exitPrice: 110,
      closedPnl: 10,
      complete: true,
    },
    {
      side: 'SHORT',
      openedAt: 2000,
      closedAt: 3000,
      entryPrice: 110,
      exitPrice: 90,
      closedPnl: 40,
      complete: true,
    },
  ]);
});

test('history that starts inside a position remains marked truncated', () => {
  const fills = [
    fill({ timestamp: 1000, side: 'A', size: 2, startPosition: 5, price: 100 }),
    fill({ timestamp: 2000, side: 'A', size: 3, startPosition: 3, price: 101 }),
  ];
  const [episode] = reconstructTradingEpisodes(fills);
  assert.equal(episode.side, 'LONG');
  assert.equal(episode.historyTruncated, true);
  assert.equal(episode.complete, false);
  assert.equal(episode.closedAt, 2000);
});

test('behaviour classifier keeps useful intraday traders and excludes bot-like scalpers', () => {
  const hour = 60 * 60 * 1000;
  const usefulEpisodes = [0, 1, 2, 3].map((index) => ({
    side: index % 3 === 0 ? 'SHORT' : 'LONG',
    openedAt: index * (2 * hour),
    closedAt: (index * (2 * hour)) + hour,
    holdMs: hour,
    fillCount: 4,
    aggressiveRatio: 0.5,
    capturedBps: index === 3 ? -20 : 45,
    closedPnl: index === 3 ? -10 : 30,
    complete: true,
  }));
  const usefulFills = usefulEpisodes.flatMap((episode, episodeIndex) => (
    [0, 1, 2, 3].map((fillIndex) => fill({
      timestamp: episode.openedAt + (fillIndex * 15 * 60 * 1000),
      side: episode.side === 'LONG' ? 'B' : 'A',
      size: 1,
      startPosition: fillIndex,
      price: 100,
      tid: (episodeIndex * 10) + fillIndex + 1,
    }))
  ));
  const useful = classifyWalletBehaviour(usefulEpisodes, usefulFills);
  assert.equal(useful.excluded, false);
  assert.ok(useful.labels.includes('INTRADAY_DIRECTIONAL'));

  const botFills = Array.from({ length: 40 }, (_, index) => fill({
    timestamp: 1000 + (index * 1000),
    side: index % 2 === 0 ? 'B' : 'A',
    size: 0.01,
    startPosition: index % 2,
    price: 100 + (index % 2),
    crossed: false,
    tid: 1000 + index,
  }));
  const botEpisodes = Array.from({ length: 20 }, (_, index) => ({
    side: index % 2 === 0 ? 'LONG' : 'SHORT',
    openedAt: 1000 + (index * 2000),
    closedAt: 2000 + (index * 2000),
    holdMs: 1000,
    fillCount: 2,
    aggressiveRatio: 0,
    capturedBps: 1,
    closedPnl: index % 2,
    complete: true,
  }));
  const bot = classifyWalletBehaviour(botEpisodes, botFills);
  assert.equal(bot.excluded, true);
  assert.ok(bot.labels.includes('BOT_LIKE'));
  assert.ok(bot.reasons.length >= 3);
});

test('complete fills and episodes round-trip through the private database', (t) => {
  const database = createIntelligenceDatabase({ path: ':memory:' });
  t.after(() => database.close());
  database.importSeeds([ADDRESS]);
  const fills = [
    fill({ timestamp: 1000, side: 'B', size: 1, startPosition: 0, price: 100, tid: 1 }),
    fill({ timestamp: 2000, side: 'A', size: 1, startPosition: 1, price: 110, closedPnl: 10, tid: 2 }),
  ];
  const episodes = reconstructTradingEpisodes(fills);

  assert.equal(database.recordFills(ADDRESS, fills), 2);
  assert.equal(database.recordFills(ADDRESS, fills), 0);
  assert.equal(database.replaceEpisodes(ADDRESS, episodes), 1);
  assert.deepEqual(database.listFills(ADDRESS).map(({ tid, startPosition }) => ({
    tid,
    startPosition,
  })), [
    { tid: 1, startPosition: 0 },
    { tid: 2, startPosition: 1 },
  ]);
  assert.equal(database.listEpisodes(ADDRESS)[0].complete, true);
});
