const TICKER_TOPIC = 'mt5.tickers.all';
const PING_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 15_000;
const MAX_COMPRESSED_FRAME_BYTES = 1_000_000;
const MAX_DECOMPRESSED_FRAME_BYTES = 2_000_000;
const MAX_TICKER_UPDATES = 5_000;

export const BYBIT_TRADFI_SYMBOLS = Object.freeze({
  EURUSD: 'EURUSD+',
  GBPUSD: 'GBPUSD+',
  XAUUSD: 'XAUUSD+',
});

const INSTRUMENT_BY_SYMBOL = Object.freeze(
  Object.fromEntries(Object.entries(BYBIT_TRADFI_SYMBOLS).map(([instrument, symbol]) => [
    symbol,
    instrument,
  ])),
);

const PRICE_DECIMALS = Object.freeze({
  EURUSD: 5,
  GBPUSD: 5,
  XAUUSD: 2,
});

const isPositiveNumber = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export function buildTradfiWebSocketUrl(timestamp = Date.now()) {
  return `wss://ws2.bybit.com/realtime_w?v=1&timestamp=${timestamp}`;
}

export function parseTradfiTickerMessage(payload) {
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

    const timestamp = Number(ticker.t);
    return [{
      instrument,
      bybitSymbol: ticker.s,
      ...(ask === undefined ? {} : { ask }),
      ...(bid === undefined ? {} : { bid }),
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    }];
  });

  return { type: message.type, updates };
}

export function mergeTradfiTicker(previous, update) {
  if (!update?.instrument || !BYBIT_TRADFI_SYMBOLS[update.instrument]) return null;
  if (previous?.instrument && previous.instrument !== update.instrument) return null;

  const ask = isPositiveNumber(update.ask) ? Number(update.ask) : Number(previous?.ask);
  const bid = isPositiveNumber(update.bid) ? Number(update.bid) : Number(previous?.bid);
  if (!isPositiveNumber(ask) || !isPositiveNumber(bid)) return null;

  const timestamp = Math.max(
    Number(previous?.timestamp) || 0,
    Number(update.timestamp) || 0,
  );

  return {
    instrument: update.instrument,
    bybitSymbol: BYBIT_TRADFI_SYMBOLS[update.instrument],
    ask,
    bid,
    price: round((ask + bid) / 2, PRICE_DECIMALS[update.instrument]),
    timestamp,
    source: 'Bybit TradFi',
  };
}

export async function decodeTradfiFrame(frame) {
  if (typeof frame === 'string') {
    if (frame.length > MAX_DECOMPRESSED_FRAME_BYTES) {
      throw new Error('Bybit прислал слишком большое live-сообщение.');
    }
    return frame;
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error('Браузер не поддерживает распаковку live-потока Bybit.');
  }

  const frameSize = frame instanceof Blob ? frame.size : frame?.byteLength;
  if (!Number.isFinite(frameSize) || frameSize > MAX_COMPRESSED_FRAME_BYTES) {
    throw new Error('Bybit прислал слишком большой live-кадр.');
  }

  const bytes = frame instanceof Blob ? await frame.arrayBuffer() : frame;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_DECOMPRESSED_FRAME_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('Распакованное live-сообщение Bybit превышает допустимый размер.');
    }
    chunks.push(value);
  }

  const decoded = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(decoded);
}

export function createBybitTradfiFeed({
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
    const message = error instanceof Error ? error.message : 'Ошибка live-потока Bybit.';
    onError({ status: 'error', message });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    clearInterval(pingTimer);
    pingTimer = undefined;
    reconnectAttempt += 1;
    const delay = Math.min(1000 * (2 ** (reconnectAttempt - 1)), MAX_RECONNECT_DELAY_MS);
    onStatus({ status: 'reconnecting', attempt: reconnectAttempt, delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const handleMessage = async (event) => {
    const decoded = await decodeTradfiFrame(event.data);
    const { updates } = parseTradfiTickerMessage(decoded);
    if (updates.length === 0) return;

    const quotes = [];
    for (const update of updates) {
      const quote = mergeTradfiTicker(quoteCache.get(update.instrument), update);
      if (!quote) continue;
      quoteCache.set(update.instrument, quote);
      quotes.push(quote);
    }
    if (quotes.length > 0) onQuotes(quotes);
  };

  function connect() {
    if (stopped) return;
    if (typeof WebSocketImpl !== 'function') {
      emitError(new Error('WebSocket недоступен в этом браузере.'));
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
      emitError(new Error('Bybit TradFi не принял WebSocket-соединение.'));
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
      socket?.close(1000, 'CalcPro live sync disabled');
      socket = undefined;
      quoteCache.clear();
    },
  };
}
