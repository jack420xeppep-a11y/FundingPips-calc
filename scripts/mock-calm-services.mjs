import { createServer } from 'node:http';

const quotes = () => {
  const timestamp = Date.now();
  return {
    version: 1,
    status: 'live',
    generatedAt: timestamp,
    staleAfterMs: 10_000,
    quotes: [
      {
        instrument: 'EURUSD',
        bybitSymbol: 'EURUSD+',
        bid: 1.1468,
        ask: 1.14682,
        mid: 1.14681,
        timestamp,
        stale: false,
      },
      {
        instrument: 'GBPUSD',
        bybitSymbol: 'GBPUSD+',
        bid: 1.3244,
        ask: 1.3246,
        mid: 1.3245,
        timestamp,
        stale: false,
      },
      {
        instrument: 'XAUUSD',
        bybitSymbol: 'XAUUSD+',
        bid: 4034.9,
        ask: 4035.1,
        mid: 4035,
        timestamp,
        stale: false,
      },
    ],
  };
};

const intelligence = () => {
  const generatedAt = Date.now();
  const probabilities = { down: 0.2, up: 0.7, neither: 0.1 };
  const paths = {
    down: { probability: 0.2, label: 'BB SL / FP TP' },
    up: { probability: 0.7, label: 'BB TP / FP SL' },
    neither: { probability: 0.1, label: 'No barrier inside horizon' },
  };
  const sentiment = {
    market: {
      status: 'ready',
      direction: 'LONG',
      score: 61,
      strength: 61,
      generatedAt,
      stableForMs: 225_000,
      regime: 'BREAKOUT',
      components: {
        trendMomentum: { weight: 26, raw: 0.8, value: 20.8 },
      },
      reasons: ['trend and momentum supports LONG'],
    },
    whale: {
      status: 'ready',
      direction: 'LONG',
      score: 72,
      strength: 72,
      qualifiedCount: 7,
      newPositions15m: { long: 5, short: 1 },
      netPositionChange15m: 1_800_000,
      netPositionChange1h: 2_400_000,
      entryCluster: { p25: 4028, p75: 4032 },
      conviction: 'HIGH',
      freshnessMs: 42_000,
      maturity: 0.72,
      reasons: ['7 qualified whale positions are aggregated'],
    },
    combined: {
      status: 'ready',
      direction: 'LONG',
      score: 66,
      strength: 66,
      generatedAt,
      stableForMs: 225_000,
      source: 'MARKET_WHALE',
    },
  };
  const decision = {
    state: 'CONFIRMED_SHORT',
    fpDirection: 'short',
    bybitDirection: 'LONG',
    autoEligible: true,
    probabilities,
    paths,
    confidence: 0.71,
    edge: 0.5,
    source: 'COMBINED',
    stableSince: generatedAt - 225_000,
    nextSwitchAllowedAt: generatedAt + 375_000,
    generatedAt,
    decisionReferencePrice: 4034.5,
    outcomeAnchorPrice: 4035,
    sentiment,
    reasons: [
      'market pressure and whale pressure are aligned',
      'stable evidence persisted beyond the confirmation window',
    ],
    freshnessMs: 0,
  };

  return {
    version: 1,
    status: 'ready',
    generatedAt,
    intent: 'transfer-to-bybit',
    horizonMs: 14_400_000,
    regime: 'BREAKOUT',
    targetBand: '0.20-0.35%',
    recommendation: {
      fpDirection: 'short',
      bybitDirection: 'LONG',
      autoEligible: true,
      stableDirection: 'short',
      stable: true,
      switchAllowedAt: decision.nextSwitchAllowedAt,
    },
    paths,
    marketSignal: 0.61,
    walletSignal: 0.72,
    combinedSignal: 0.66,
    confidence: 0.71,
    maturity: 0.72,
    cohortSize: 7,
    edge: 0.5,
    reasons: [...decision.reasons],
    candidates: {
      long: {
        probabilities: { down: 0.3, up: 0.6, neither: 0.1 },
        bybitTpProbability: 0.3,
        fundingPipsTpProbability: 0.6,
        marketBybitTpProbability: 0.31,
        walletBybitTpProbability: 0.28,
        expectedValueUsdEquivalent: -8,
      },
      short: {
        probabilities,
        bybitTpProbability: 0.7,
        fundingPipsTpProbability: 0.2,
        marketBybitTpProbability: 0.61,
        walletBybitTpProbability: 0.72,
        expectedValueUsdEquivalent: 12,
      },
    },
    economics: {
      phase: 'p1',
      includesFeesOrSpread: false,
      executionEnabled: false,
      valueType: 'challenge-progress-equivalent',
    },
    decision,
    sentiment,
    walletState: {
      status: 'ready',
      maturity: 0.72,
      qualifiedCount: 7,
      weight: 0.32,
      freshnessMs: 42_000,
    },
    market: {
      symbol: 'xyz:GOLD',
      bybitSymbol: 'XAUUSD+',
      hyperliquidMid: 4035.2,
      bybitMid: 4035,
      basisBps: 0.5,
      session: 'LONDON',
      hyperliquidTimestamp: generatedAt,
      bybitTimestamp: generatedAt,
      priceContext: {
        executionPrice: 4035,
        decisionReferencePrice: 4034.5,
        outcomeAnchorPrice: 4035,
        executionTimestamp: generatedAt,
        referenceTimestamp: generatedAt,
        mode: 'NORMAL',
      },
      stale: false,
    },
  };
};

const serveSse = (request, response, createSnapshot) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const write = () => response.write(`event: snapshot\ndata: ${JSON.stringify(createSnapshot())}\n\n`);
  write();
  const timer = setInterval(write, 1_000);
  request.on('close', () => clearInterval(timer));
};

const quoteServer = createServer((request, response) => {
  if (request.url === '/api/quote-health') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'live', quoteCount: 3 }));
    return;
  }
  serveSse(request, response, quotes);
});

const intelligenceServer = createServer((request, response) => {
  if (request.url === '/api/intelligence/health') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'live', database: { schemaVersion: 2 } }));
    return;
  }
  serveSse(request, response, intelligence);
});

await Promise.all([
  new Promise((resolve) => quoteServer.listen(8787, '127.0.0.1', resolve)),
  new Promise((resolve) => intelligenceServer.listen(8788, '127.0.0.1', resolve)),
]);

console.log(JSON.stringify({ event: 'mock_calm_services_started' }));

const stop = () => Promise.all([
  new Promise((resolve) => quoteServer.close(resolve)),
  new Promise((resolve) => intelligenceServer.close(resolve)),
]);

process.on('SIGTERM', async () => {
  await stop();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await stop();
  process.exit(0);
});
