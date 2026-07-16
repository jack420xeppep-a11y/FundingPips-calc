import { createDecisionPriceTracker } from './price-context.js';

const MAX_MESSAGE_BYTES = 2_000_000;
const MAX_TRADE_UPDATES = 5_000;
const MAX_BOOK_LEVELS = 100;
const DEFAULT_MAX_TRADES = 20_000;
const DEFAULT_MAX_PRICE_SAMPLES = 7_200;
const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 50_000;

export const GOLD_COIN = 'xyz:GOLD';
export const GOLD_SUBSCRIPTIONS = Object.freeze([
  Object.freeze({ type: 'trades', coin: GOLD_COIN }),
  Object.freeze({ type: 'bbo', coin: GOLD_COIN }),
  Object.freeze({ type: 'l2Book', coin: GOLD_COIN, nSigFigs: 5 }),
  Object.freeze({ type: 'candle', coin: GOLD_COIN, interval: '1m' }),
  Object.freeze({ type: 'activeAssetCtx', coin: GOLD_COIN }),
]);

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const UPSTREAM_STATUSES = new Set([
  'connecting',
  'connected',
  'reconnecting',
  'error',
]);

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const isFiniteNumber = (value) => Number.isFinite(Number(value));

const round = (value, decimals = 8) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const clamp = (value, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, Number(value)));

const parsePayload = (payload) => {
  if (typeof payload === 'string') {
    if (Buffer.byteLength(payload, 'utf8') > MAX_MESSAGE_BYTES) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  return payload;
};

const parseLevel = (level) => {
  if (!level || !isPositive(level.px) || !isPositive(level.sz)) return null;
  const orderCount = Number(level.n);
  if (!Number.isInteger(orderCount) || orderCount < 1 || orderCount > 1_000_000) {
    return null;
  }
  return {
    price: Number(level.px),
    size: Number(level.sz),
    orderCount,
  };
};

const parseTrade = (trade) => {
  if (
    trade?.coin !== GOLD_COIN ||
    !['A', 'B'].includes(trade.side) ||
    !isPositive(trade.px) ||
    !isPositive(trade.sz) ||
    !Number.isSafeInteger(Number(trade.time)) ||
    Number(trade.time) <= 0 ||
    !HASH_PATTERN.test(trade.hash ?? '') ||
    !Number.isSafeInteger(Number(trade.tid)) ||
    Number(trade.tid) < 0 ||
    !Array.isArray(trade.users) ||
    trade.users.length !== 2 ||
    !trade.users.every((address) => ADDRESS_PATTERN.test(address))
  ) {
    return null;
  }

  const price = Number(trade.px);
  const size = Number(trade.sz);

  return {
    coin: GOLD_COIN,
    side: trade.side,
    price,
    size,
    notional: round(price * size),
    timestamp: Number(trade.time),
    hash: trade.hash.toLowerCase(),
    tid: Number(trade.tid),
    buyer: trade.users[0].toLowerCase(),
    seller: trade.users[1].toLowerCase(),
    aggressor: trade.side === 'B' ? 'buyer' : 'seller',
  };
};

export function buildHyperliquidWebSocketUrl() {
  return 'wss://api.hyperliquid.xyz/ws';
}

export function parseHyperliquidMessage(payload) {
  const message = parsePayload(payload);
  if (!message || typeof message.channel !== 'string') return null;

  if (message.channel === 'trades') {
    if (
      !Array.isArray(message.data) ||
      message.data.length < 1 ||
      message.data.length > MAX_TRADE_UPDATES
    ) {
      return null;
    }
    const trades = message.data.map(parseTrade);
    if (trades.some((trade) => trade === null)) return null;
    return { type: 'trades', trades };
  }

  if (message.channel === 'bbo') {
    const { data } = message;
    if (
      data?.coin !== GOLD_COIN ||
      !Number.isSafeInteger(Number(data.time)) ||
      !Array.isArray(data.bbo) ||
      data.bbo.length !== 2
    ) {
      return null;
    }
    const bid = parseLevel(data.bbo[0]);
    const ask = parseLevel(data.bbo[1]);
    if (!bid || !ask || ask.price < bid.price) return null;
    return {
      type: 'bbo',
      timestamp: Number(data.time),
      bid: bid.price,
      ask: ask.price,
      bidSize: bid.size,
      askSize: ask.size,
    };
  }

  if (message.channel === 'l2Book') {
    const { data } = message;
    if (
      data?.coin !== GOLD_COIN ||
      !Number.isSafeInteger(Number(data.time)) ||
      !Array.isArray(data.levels) ||
      data.levels.length !== 2 ||
      data.levels.some((levels) => (
        !Array.isArray(levels) ||
        levels.length < 1 ||
        levels.length > MAX_BOOK_LEVELS
      ))
    ) {
      return null;
    }

    const bids = data.levels[0].map(parseLevel);
    const asks = data.levels[1].map(parseLevel);
    if (bids.some((level) => !level) || asks.some((level) => !level)) return null;
    if (asks[0].price < bids[0].price) return null;
    const bidDepth = bids.reduce((total, level) => total + level.size, 0);
    const askDepth = asks.reduce((total, level) => total + level.size, 0);
    const totalDepth = bidDepth + askDepth;

    return {
      type: 'book',
      timestamp: Number(data.time),
      bid: bids[0].price,
      ask: asks[0].price,
      bidDepth: round(bidDepth),
      askDepth: round(askDepth),
      imbalance: totalDepth > 0 ? round((bidDepth - askDepth) / totalDepth) : 0,
    };
  }

  if (message.channel === 'activeAssetCtx') {
    const { data } = message;
    const context = data?.ctx;
    if (
      data?.coin !== GOLD_COIN ||
      !isFiniteNumber(context?.funding) ||
      !isPositive(context?.openInterest) ||
      !isFiniteNumber(context?.premium) ||
      !isPositive(context?.oraclePx) ||
      !isPositive(context?.markPx) ||
      !isPositive(context?.midPx) ||
      !isPositive(context?.dayNtlVlm)
    ) {
      return null;
    }
    return {
      type: 'context',
      funding: Number(context.funding),
      openInterest: Number(context.openInterest),
      premium: Number(context.premium),
      oraclePrice: Number(context.oraclePx),
      markPrice: Number(context.markPx),
      midPrice: Number(context.midPx),
      dayNotionalVolume: Number(context.dayNtlVlm),
    };
  }

  if (message.channel === 'candle') {
    const candle = message.data;
    if (
      candle?.s !== GOLD_COIN ||
      candle.i !== '1m' ||
      !Number.isSafeInteger(Number(candle.t)) ||
      !Number.isSafeInteger(Number(candle.T)) ||
      Number(candle.T) < Number(candle.t) ||
      !isPositive(candle.o) ||
      !isPositive(candle.c) ||
      !isPositive(candle.h) ||
      !isPositive(candle.l) ||
      !isPositive(candle.v) ||
      !Number.isInteger(Number(candle.n)) ||
      Number(candle.n) < 0
    ) {
      return null;
    }
    const high = Number(candle.h);
    const low = Number(candle.l);
    const open = Number(candle.o);
    const close = Number(candle.c);
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
      return null;
    }
    return {
      type: 'candle',
      openTimestamp: Number(candle.t),
      closeTimestamp: Number(candle.T),
      interval: '1m',
      open,
      close,
      high,
      low,
      volume: Number(candle.v),
      tradeCount: Number(candle.n),
    };
  }

  return null;
}

const rollingFlow = (trades, now, windowMs) => {
  let buy = 0;
  let sell = 0;
  const threshold = now - windowMs;
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const trade = trades[index];
    if (trade.timestamp < threshold) break;
    if (trade.side === 'B') buy += trade.notional;
    else sell += trade.notional;
  }
  const total = buy + sell;
  return total > 0 ? round((buy - sell) / total) : 0;
};

const calculateMomentum = (samples, now, windowMs) => {
  if (samples.length < 2) return 0;
  const current = samples.at(-1);
  const threshold = now - windowMs;
  let reference = samples[0];
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].timestamp <= threshold) {
      reference = samples[index];
      break;
    }
  }
  if (!isPositive(reference.price) || !isPositive(current.price)) return 0;
  return round(((current.price / reference.price) - 1) * 10_000, 4);
};

const calculateVolatility = (samples) => {
  if (samples.length < 3) return 0;
  const returns = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1].price;
    const current = samples[index].price;
    if (isPositive(previous) && isPositive(current)) {
      returns.push(Math.log(current / previous) * 10_000);
    }
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) /
    (returns.length - 1);
  return round(Math.sqrt(Math.max(0, variance)), 4);
};

const sessionForTimestamp = (timestamp) => {
  const hour = new Date(timestamp).getUTCHours();
  if (hour < 7) return 'ASIA';
  if (hour < 13) return 'LONDON';
  if (hour < 21) return 'NEW_YORK';
  return 'OFF_HOURS';
};

export function createGoldMarketStore({
  now = Date.now,
  maxTrades = DEFAULT_MAX_TRADES,
  maxPriceSamples = DEFAULT_MAX_PRICE_SAMPLES,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  onTrades = () => {},
  onSnapshot = () => {},
  priceTracker = createDecisionPriceTracker({ now }),
} = {}) {
  if (!Number.isInteger(maxTrades) || maxTrades < 1 || maxTrades > 1_000_000) {
    throw new Error('maxTrades must be between 1 and 1000000.');
  }
  if (
    !Number.isInteger(maxPriceSamples) ||
    maxPriceSamples < 2 ||
    maxPriceSamples > 250_000
  ) {
    throw new Error('maxPriceSamples must be between 2 and 250000.');
  }
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 120_000) {
    throw new Error('staleAfterMs must be between 1000 and 120000.');
  }
  if (!priceTracker?.update || !priceTracker?.snapshot) {
    throw new Error('Decision price tracker is required.');
  }

  const trades = [];
  const priceSamples = [];
  const dedupeKeys = new Set();
  const dedupeOrder = [];
  const listeners = new Set();
  let hyperliquidStatus = 'connecting';
  let hyperliquidMessage = '';
  let hyperliquidLastAt = 0;
  let bybitLastAt = 0;
  let bbo = null;
  let context = null;
  let bybit = null;
  let bookImbalance = 0;
  let previousOpenInterest = null;
  let openInterestChangePct = 0;
  let lastCandle = null;

  const appendPrice = (price, timestamp) => {
    if (!isPositive(price) || !isPositive(timestamp)) return;
    const previous = priceSamples.at(-1);
    if (previous && previous.timestamp === timestamp && previous.price === price) return;
    priceSamples.push({ price: Number(price), timestamp: Number(timestamp) });
    if (priceSamples.length > maxPriceSamples) {
      priceSamples.splice(0, priceSamples.length - maxPriceSamples);
    }
  };

  const removeExpiredTrades = (currentTime) => {
    const threshold = currentTime - 60 * 60 * 1_000;
    while (trades[0]?.timestamp < threshold) trades.shift();
    if (trades.length > maxTrades) trades.splice(0, trades.length - maxTrades);
  };

  const removeOldDedupeKeys = () => {
    const maximum = Math.max(100, maxTrades * 5);
    while (dedupeOrder.length > maximum) {
      dedupeKeys.delete(dedupeOrder.shift());
    }
  };

  const snapshot = () => {
    const generatedAt = now();
    removeExpiredTrades(generatedAt);
    const hyperliquidStale =
      hyperliquidLastAt === 0 || generatedAt - hyperliquidLastAt > staleAfterMs;
    const bybitStale =
      bybitLastAt === 0 ||
      generatedAt - bybitLastAt > staleAfterMs ||
      bybit?.stale !== false;

    let status = hyperliquidStatus;
    if (hyperliquidStatus === 'connected') {
      if (!bbo || !bybit) status = 'connecting';
      else if (hyperliquidStale || bybitStale) status = 'stale';
      else status = 'live';
    }

    const hyperliquidMid = context?.midPrice ?? (
      bbo ? round((bbo.bid + bbo.ask) / 2) : null
    );
    const basisBps = isPositive(hyperliquidMid) && isPositive(bybit?.mid)
      ? round(((hyperliquidMid - bybit.mid) / bybit.mid) * 10_000, 4)
      : null;

    return {
      version: 1,
      status,
      generatedAt,
      staleAfterMs,
      market: {
        coin: GOLD_COIN,
        session: sessionForTimestamp(generatedAt),
        priceContext: priceTracker.snapshot(),
        hyperliquid: {
          bid: bbo?.bid ?? null,
          ask: bbo?.ask ?? null,
          mid: hyperliquidMid,
          mark: context?.markPrice ?? null,
          oracle: context?.oraclePrice ?? null,
          openInterest: context?.openInterest ?? null,
          funding: context?.funding ?? null,
          premium: context?.premium ?? null,
          dayNotionalVolume: context?.dayNotionalVolume ?? null,
          timestamp: hyperliquidLastAt || null,
          stale: hyperliquidStale,
        },
        bybit: bybit ? { ...bybit, stale: bybitStale } : null,
        basisBps,
      },
      features: {
        aggressiveFlow5m: rollingFlow(trades, generatedAt, 5 * 60 * 1_000),
        aggressiveFlow15m: rollingFlow(trades, generatedAt, 15 * 60 * 1_000),
        aggressiveFlow60m: rollingFlow(trades, generatedAt, 60 * 60 * 1_000),
        bookImbalance: round(bookImbalance, 6),
        momentum5mBps: calculateMomentum(priceSamples, generatedAt, 5 * 60 * 1_000),
        momentum15mBps: calculateMomentum(priceSamples, generatedAt, 15 * 60 * 1_000),
        volatilityBps: calculateVolatility(priceSamples),
        openInterestChangePct: round(openInterestChangePct, 6),
      },
      candle: lastCandle,
      diagnostics: {
        recentTradeCount: trades.length,
        priceSampleCount: priceSamples.length,
        dedupeKeyCount: dedupeKeys.size,
      },
      ...(hyperliquidMessage ? { message: hyperliquidMessage } : {}),
    };
  };

  const notify = () => {
    const current = snapshot();
    onSnapshot(current);
    for (const listener of listeners) listener(current);
  };

  return {
    snapshot,
    setHyperliquidStatus(status, message = '') {
      if (!UPSTREAM_STATUSES.has(status)) return;
      hyperliquidStatus = status;
      hyperliquidMessage = typeof message === 'string' ? message.slice(0, 240) : '';
      notify();
    },
    applyHyperliquid(event) {
      if (!event || typeof event.type !== 'string') return;
      const receivedAt = now();

      if (event.type === 'trades') {
        const unique = [];
        for (const trade of event.trades) {
          const key = `${trade.timestamp}:${trade.coin}:${trade.tid}`;
          if (dedupeKeys.has(key)) continue;
          dedupeKeys.add(key);
          dedupeOrder.push(key);
          trades.push(trade);
          unique.push(trade);
          appendPrice(trade.price, trade.timestamp);
        }
        removeOldDedupeKeys();
        removeExpiredTrades(receivedAt);
        if (unique.length > 0) {
          hyperliquidLastAt = receivedAt;
          onTrades(unique);
          notify();
        }
        return;
      }

      if (event.type === 'bbo') {
        bbo = {
          bid: event.bid,
          ask: event.ask,
          bidSize: event.bidSize,
          askSize: event.askSize,
          sourceTimestamp: event.timestamp,
        };
        const totalSize = event.bidSize + event.askSize;
        bookImbalance = totalSize > 0
          ? clamp((event.bidSize - event.askSize) / totalSize, -1, 1)
          : 0;
        hyperliquidLastAt = receivedAt;
        appendPrice((event.bid + event.ask) / 2, receivedAt);
        notify();
        return;
      }

      if (event.type === 'book') {
        bbo = {
          bid: event.bid,
          ask: event.ask,
          bidSize: event.bidDepth,
          askSize: event.askDepth,
          sourceTimestamp: event.timestamp,
        };
        bookImbalance = clamp(event.imbalance, -1, 1);
        hyperliquidLastAt = receivedAt;
        appendPrice((event.bid + event.ask) / 2, receivedAt);
        notify();
        return;
      }

      if (event.type === 'context') {
        if (isPositive(previousOpenInterest)) {
          openInterestChangePct =
            ((event.openInterest - previousOpenInterest) / previousOpenInterest) * 100;
        }
        previousOpenInterest = event.openInterest;
        context = event;
        hyperliquidLastAt = receivedAt;
        appendPrice(event.midPrice, receivedAt);
        notify();
        return;
      }

      if (event.type === 'candle') {
        lastCandle = event;
        hyperliquidLastAt = receivedAt;
        appendPrice(event.close, event.closeTimestamp);
        notify();
      }
    },
    applyBybitQuote(quote) {
      if (
        quote?.instrument !== 'XAUUSD' ||
        quote.bybitSymbol !== 'XAUUSD+' ||
        !isPositive(quote.bid) ||
        !isPositive(quote.ask) ||
        Number(quote.ask) < Number(quote.bid) ||
        !isPositive(quote.mid) ||
        Number(quote.mid) < Number(quote.bid) ||
        Number(quote.mid) > Number(quote.ask) ||
        !isPositive(quote.timestamp) ||
        typeof quote.stale !== 'boolean'
      ) {
        return;
      }
      bybit = {
        instrument: 'XAUUSD',
        bybitSymbol: 'XAUUSD+',
        bid: Number(quote.bid),
        ask: Number(quote.ask),
        mid: Number(quote.mid),
        timestamp: Number(quote.timestamp),
        stale: quote.stale,
      };
      bybitLastAt = now();
      priceTracker.update({ price: bybit.mid, timestamp: bybitLastAt });
      notify();
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('Listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createHyperliquidGoldUpstream({
  onEvent = () => {},
  onStatus = () => {},
  onError = () => {},
  WebSocketImpl = globalThis.WebSocket,
  reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  if (
    !Number.isInteger(reconnectBaseMs) ||
    reconnectBaseMs < 1 ||
    !Number.isInteger(reconnectMaxMs) ||
    reconnectMaxMs < reconnectBaseMs ||
    reconnectMaxMs > 120_000
  ) {
    throw new Error('Invalid reconnect bounds.');
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1_000 || heartbeatMs > 120_000) {
    throw new Error('heartbeatMs must be between 1000 and 120000.');
  }

  let socket;
  let heartbeatTimer;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let stopped = true;

  const clearTimers = () => {
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    heartbeatTimer = undefined;
    reconnectTimer = undefined;
  };

  const emitError = (error) => {
    const message = error instanceof Error ? error.message : 'Hyperliquid upstream failed.';
    onError({ status: 'error', message });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    reconnectAttempt += 1;
    const delay = Math.min(
      reconnectBaseMs * (2 ** Math.max(0, reconnectAttempt - 1)),
      reconnectMaxMs,
    );
    onStatus({ status: 'reconnecting', attempt: reconnectAttempt, delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  };

  function connect() {
    if (stopped) return;
    if (typeof WebSocketImpl !== 'function') {
      emitError(new Error('WebSocket is unavailable in this Node.js runtime.'));
      scheduleReconnect();
      return;
    }

    onStatus({ status: reconnectAttempt > 0 ? 'reconnecting' : 'connecting' });
    const activeSocket = new WebSocketImpl(buildHyperliquidWebSocketUrl());
    socket = activeSocket;

    activeSocket.addEventListener('open', () => {
      if (stopped || activeSocket !== socket) return;
      reconnectAttempt = 0;
      for (const subscription of GOLD_SUBSCRIPTIONS) {
        activeSocket.send(JSON.stringify({ method: 'subscribe', subscription }));
      }
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (activeSocket.readyState === WebSocketImpl.OPEN) {
          activeSocket.send(JSON.stringify({ method: 'ping' }));
        }
      }, heartbeatMs);
      heartbeatTimer.unref?.();
      onStatus({ status: 'connected' });
    });

    activeSocket.addEventListener('message', (message) => {
      if (stopped || activeSocket !== socket) return;
      const event = parseHyperliquidMessage(message.data);
      if (event) onEvent(event);
    });

    activeSocket.addEventListener('error', () => {
      if (stopped || activeSocket !== socket) return;
      emitError(new Error('Hyperliquid rejected or interrupted the gold WebSocket.'));
      try {
        activeSocket.close();
      } catch {
        // The reconnect timer remains the recovery path.
      }
      scheduleReconnect();
    });

    activeSocket.addEventListener('close', () => {
      if (stopped || activeSocket !== socket) return;
      scheduleReconnect();
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearTimers();
      try {
        socket?.close(1000, 'CalcPro HyperGold collector stopped');
      } catch {
        // Shutdown is complete even if the remote socket is already gone.
      }
      socket = undefined;
    },
  };
}
