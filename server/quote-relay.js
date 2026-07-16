import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

const TICKER_TOPIC = 'mt5.tickers.all';
const PING_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_COMPRESSED_FRAME_BYTES = 1_000_000;
const MAX_DECOMPRESSED_FRAME_BYTES = 2_000_000;
const MAX_TICKER_UPDATES = 5_000;
const DEFAULT_MAX_CLIENTS = 100;

export const BYBIT_TRADFI_SYMBOLS = Object.freeze({
  EURUSD: 'EURUSD+',
  GBPUSD: 'GBPUSD+',
  XAUUSD: 'XAUUSD+',
});

const INSTRUMENT_ORDER = Object.freeze(Object.keys(BYBIT_TRADFI_SYMBOLS));
const INSTRUMENT_BY_SYMBOL = Object.freeze(
  Object.fromEntries(INSTRUMENT_ORDER.map((instrument) => [
    BYBIT_TRADFI_SYMBOLS[instrument],
    instrument,
  ])),
);
const PRICE_DECIMALS = Object.freeze({ EURUSD: 5, GBPUSD: 5, XAUUSD: 2 });
const UPSTREAM_STATUSES = new Set(['connecting', 'connected', 'reconnecting', 'error']);

const isPositiveNumber = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

export function buildTradfiWebSocketUrl(timestamp = Date.now()) {
  return `wss://ws2.bybit.com/realtime_w?v=1&timestamp=${timestamp}`;
}

export async function decodeBybitFrame(frame) {
  if (typeof frame === 'string') {
    if (frame.length > MAX_DECOMPRESSED_FRAME_BYTES) {
      throw new Error('Bybit text frame exceeds the relay limit.');
    }
    return frame;
  }

  let bytes;
  if (frame instanceof Blob) {
    if (frame.size > MAX_COMPRESSED_FRAME_BYTES) {
      throw new Error('Bybit binary frame exceeds the relay limit.');
    }
    bytes = Buffer.from(await frame.arrayBuffer());
  } else if (frame instanceof ArrayBuffer) {
    bytes = Buffer.from(frame);
  } else if (ArrayBuffer.isView(frame)) {
    bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  } else {
    throw new Error('Bybit sent an unsupported frame type.');
  }

  if (bytes.byteLength > MAX_COMPRESSED_FRAME_BYTES) {
    throw new Error('Bybit binary frame exceeds the relay limit.');
  }

  try {
    return gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_FRAME_BYTES }).toString('utf8');
  } catch {
    throw new Error('Bybit gzip frame could not be decoded safely.');
  }
}

export function parseBybitMessage(payload) {
  let message;
  try {
    message = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return { type: 'unknown', updates: [] };
  }

  if (
    message?.topic !== TICKER_TOPIC ||
    !['snapshot', 'delta'].includes(message.type) ||
    !Array.isArray(message.data) ||
    message.data.length > MAX_TICKER_UPDATES
  ) {
    return { type: 'unknown', updates: [] };
  }

  const updates = message.data.flatMap((ticker) => {
    const instrument = INSTRUMENT_BY_SYMBOL[ticker?.s];
    if (!instrument) return [];

    const ask = isPositiveNumber(ticker.a) ? Number(ticker.a) : undefined;
    const bid = isPositiveNumber(ticker.b) ? Number(ticker.b) : undefined;
    if (ask === undefined && bid === undefined) return [];

    const sourceTimestamp = Number(ticker.t);
    if (!Number.isFinite(sourceTimestamp) || sourceTimestamp <= 0) return [];
    return [{
      instrument,
      bybitSymbol: ticker.s,
      ...(ask === undefined ? {} : { ask }),
      ...(bid === undefined ? {} : { bid }),
      sourceTimestamp,
    }];
  });

  return { type: message.type, updates };
}

export function mergeBybitQuote(previous, update, receivedAt = Date.now()) {
  if (!update?.instrument || !BYBIT_TRADFI_SYMBOLS[update.instrument]) return null;
  if (previous?.instrument && previous.instrument !== update.instrument) return null;

  const ask = isPositiveNumber(update.ask) ? Number(update.ask) : Number(previous?.ask);
  const bid = isPositiveNumber(update.bid) ? Number(update.bid) : Number(previous?.bid);
  if (!isPositiveNumber(ask) || !isPositiveNumber(bid) || ask < bid) return null;

  const sourceTimestamp = Math.max(
    Number(previous?.sourceTimestamp) || 0,
    Number(update.sourceTimestamp) || 0,
  );
  if (!isPositiveNumber(sourceTimestamp) || !isPositiveNumber(receivedAt)) return null;

  return {
    instrument: update.instrument,
    bybitSymbol: BYBIT_TRADFI_SYMBOLS[update.instrument],
    bid,
    ask,
    mid: round((bid + ask) / 2, PRICE_DECIMALS[update.instrument]),
    timestamp: Number(receivedAt),
    sourceTimestamp,
  };
}

export function createQuoteStore({ now = Date.now, staleAfterMs = 10_000 } = {}) {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 60_000) {
    throw new Error('staleAfterMs must be between 1000 and 60000.');
  }

  const quoteCache = new Map();
  const listeners = new Set();
  let upstreamStatus = 'connecting';
  let upstreamMessage = '';

  const snapshot = () => {
    const generatedAt = now();
    const quotes = INSTRUMENT_ORDER.flatMap((instrument) => {
      const quote = quoteCache.get(instrument);
      if (!quote) return [];
      const { sourceTimestamp: _sourceTimestamp, ...publicQuote } = quote;
      return [{
        ...publicQuote,
        stale: generatedAt - quote.timestamp > staleAfterMs,
      }];
    });

    let status = upstreamStatus;
    if (upstreamStatus === 'connected') {
      if (quotes.length === 0) status = 'connecting';
      else status = quotes.every(({ stale }) => stale) ? 'stale' : 'live';
    }

    return {
      version: 1,
      status,
      generatedAt,
      staleAfterMs,
      quotes,
      ...(upstreamMessage ? { message: upstreamMessage } : {}),
    };
  };

  const notify = () => {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  };

  return {
    staleAfterMs,
    snapshot,
    applyQuotes(quotes) {
      let changed = false;
      for (const quote of quotes) {
        if (!quote || !BYBIT_TRADFI_SYMBOLS[quote.instrument]) continue;
        quoteCache.set(quote.instrument, quote);
        changed = true;
      }
      if (changed) notify();
    },
    setStatus(status, message = '') {
      if (!UPSTREAM_STATUSES.has(status)) return;
      upstreamStatus = status;
      upstreamMessage = typeof message === 'string' ? message.slice(0, 240) : '';
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const jsonHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

const sendJson = (response, statusCode, payload, extraHeaders = {}) => {
  response.writeHead(statusCode, { ...jsonHeaders, ...extraHeaders });
  response.end(JSON.stringify(payload));
};

const formatSse = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

export function createQuoteRelayHttpServer({
  store,
  host = '127.0.0.1',
  port = 8787,
  heartbeatMs = 15_000,
  statusPollMs = 1_000,
  maxClients = DEFAULT_MAX_CLIENTS,
} = {}) {
  if (!store?.snapshot || !store?.subscribe) throw new Error('A quote store is required.');
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Relay must bind to loopback.');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid port.');
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 1_000) {
    throw new Error('maxClients must be between 1 and 1000.');
  }

  const clients = new Map();
  let listening = false;
  let lastStateSignature = '';

  const writeClient = (client, frame) => {
    if (client.response.destroyed || client.response.writableEnded) return;
    if (client.blocked) {
      client.pending = frame;
      return;
    }
    if (!client.response.write(frame)) {
      client.blocked = true;
      client.response.once('drain', () => {
        client.blocked = false;
        const pending = client.pending;
        client.pending = null;
        if (pending) writeClient(client, pending);
      });
    }
  };

  const broadcast = (payload) => {
    const frame = formatSse('snapshot', payload);
    for (const client of clients.values()) writeClient(client, frame);
  };

  const unsubscribe = store.subscribe(broadcast);
  const heartbeatTimer = setInterval(() => {
    for (const client of clients.values()) writeClient(client, ': keepalive\n\n');
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  const statusTimer = setInterval(() => {
    const current = store.snapshot();
    const signature = `${current.status}:${current.quotes.map((quote) => quote.stale).join(',')}`;
    if (signature !== lastStateSignature) {
      lastStateSignature = signature;
      broadcast(current);
    }
  }, statusPollMs);
  statusTimer.unref?.();

  const server = createServer((request, response) => {
    const pathname = request.url?.split('?', 1)[0] ?? '/';

    if (pathname === '/api/quote-health') {
      if (request.method !== 'GET') {
        sendJson(response, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed.' },
        }, { Allow: 'GET' });
        return;
      }

      const current = store.snapshot();
      const ready = current.quotes.length === 3 && ['live', 'stale'].includes(current.status);
      sendJson(response, ready ? 200 : 503, {
        data: {
          status: current.status,
          clientCount: clients.size,
          quoteCount: current.quotes.length,
          generatedAt: current.generatedAt,
        },
      });
      return;
    }

    if (pathname === '/api/quotes') {
      if (request.method !== 'GET') {
        sendJson(response, 405, {
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed.' },
        }, { Allow: 'GET' });
        return;
      }
      if (clients.size >= maxClients) {
        sendJson(response, 503, {
          error: { code: 'CLIENT_LIMIT', message: 'Quote relay client limit reached.' },
        }, { 'Retry-After': '5' });
        return;
      }

      response.writeHead(200, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders?.();

      const client = { response, blocked: false, pending: null };
      clients.set(response, client);
      writeClient(client, formatSse('snapshot', store.snapshot()));

      request.on('close', () => clients.delete(response));
      return;
    }

    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', message: 'Quote relay endpoint not found.' },
    });
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 0;

  return {
    async listen() {
      if (listening) throw new Error('Quote relay is already listening.');
      await new Promise((resolve, reject) => {
        const handleError = (error) => reject(error);
        server.once('error', handleError);
        server.listen(port, host, () => {
          server.off('error', handleError);
          resolve();
        });
      });
      listening = true;
      const address = server.address();
      return `http://${host}:${address.port}`;
    },
    async close() {
      unsubscribe();
      clearInterval(heartbeatTimer);
      clearInterval(statusTimer);
      for (const client of clients.values()) client.response.end();
      clients.clear();
      if (!listening) return;
      await new Promise((resolve) => server.close(resolve));
      listening = false;
    },
  };
}

export function createBybitTradfiUpstream({
  onQuotes = () => {},
  onStatus = () => {},
  onError = () => {},
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
} = {}) {
  const quoteCache = new Map();
  let socket;
  let pingTimer;
  let reconnectTimer;
  let reconnectAttempt = 0;
  let stopped = true;
  let processing = Promise.resolve();

  const clearTimers = () => {
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    pingTimer = undefined;
    reconnectTimer = undefined;
  };

  const emitError = (error) => {
    const message = error instanceof Error ? error.message : 'Bybit upstream failed.';
    onError({ status: 'error', message });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    clearInterval(pingTimer);
    pingTimer = undefined;
    reconnectAttempt += 1;
    const delay = Math.min(1_000 * (2 ** (reconnectAttempt - 1)), MAX_RECONNECT_DELAY_MS);
    onStatus({ status: 'reconnecting', attempt: reconnectAttempt, delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const handleMessage = async (event) => {
    const decoded = await decodeBybitFrame(event.data);
    const { updates } = parseBybitMessage(decoded);
    if (updates.length === 0) return;

    const quotes = [];
    for (const update of updates) {
      const quote = mergeBybitQuote(quoteCache.get(update.instrument), update, now());
      if (!quote) continue;
      quoteCache.set(update.instrument, quote);
      quotes.push(quote);
    }
    if (quotes.length > 0) onQuotes(quotes);
  };

  function connect() {
    if (stopped) return;
    if (typeof WebSocketImpl !== 'function') {
      emitError(new Error('WebSocket is unavailable in this Node.js runtime.'));
      scheduleReconnect();
      return;
    }

    onStatus({ status: reconnectAttempt > 0 ? 'reconnecting' : 'connecting' });
    const activeSocket = new WebSocketImpl(buildTradfiWebSocketUrl(now()));
    socket = activeSocket;
    activeSocket.binaryType = 'arraybuffer';

    activeSocket.addEventListener('open', () => {
      if (activeSocket !== socket || stopped) return;
      reconnectAttempt = 0;
      activeSocket.send(JSON.stringify({ op: 'subscribe', args: [TICKER_TOPIC] }));
      activeSocket.send(JSON.stringify({ op: 'ping' }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (activeSocket.readyState === WebSocketImpl.OPEN) {
          activeSocket.send(JSON.stringify({ op: 'ping' }));
        }
      }, PING_INTERVAL_MS);
      onStatus({ status: 'connected' });
    });

    activeSocket.addEventListener('message', (event) => {
      if (activeSocket !== socket || stopped) return;
      processing = processing.then(() => handleMessage(event)).catch(emitError);
    });

    activeSocket.addEventListener('error', () => {
      if (activeSocket !== socket || stopped) return;
      emitError(new Error('Bybit TradFi rejected the upstream WebSocket.'));
      try {
        activeSocket.close();
      } catch {
        // Reconnect below remains the source of recovery even if close itself fails.
      }
      scheduleReconnect();
    });

    activeSocket.addEventListener('close', () => {
      if (activeSocket !== socket || stopped) return;
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
      socket?.close(1000, 'CalcPro quote relay stopped');
      socket = undefined;
      quoteCache.clear();
    },
  };
}
