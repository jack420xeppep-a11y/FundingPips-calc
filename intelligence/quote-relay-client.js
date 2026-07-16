const DEFAULT_RELAY_URL = 'http://127.0.0.1:8787/api/quotes';
const MAX_SSE_BUFFER_BYTES = 2_000_000;
const RELAY_STATUSES = new Set([
  'connecting',
  'connected',
  'live',
  'reconnecting',
  'stale',
  'error',
]);

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function parseBybitRelaySnapshot(payload) {
  let snapshot;
  try {
    snapshot = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }

  if (
    snapshot?.version !== 1 ||
    !RELAY_STATUSES.has(snapshot.status) ||
    !Array.isArray(snapshot.quotes) ||
    snapshot.quotes.length > 3
  ) {
    return null;
  }

  const rawQuote = snapshot.quotes.find((quote) => (
    quote?.instrument === 'XAUUSD' && quote.bybitSymbol === 'XAUUSD+'
  ));
  if (!rawQuote) return { status: snapshot.status, quote: null };

  const bid = Number(rawQuote.bid);
  const ask = Number(rawQuote.ask);
  const mid = Number(rawQuote.mid);
  const timestamp = Number(rawQuote.timestamp);
  if (
    !isPositive(bid) ||
    !isPositive(ask) ||
    ask < bid ||
    !isPositive(mid) ||
    mid < bid ||
    mid > ask ||
    !isPositive(timestamp) ||
    typeof rawQuote.stale !== 'boolean'
  ) {
    return null;
  }

  return {
    status: rawQuote.stale ? 'stale' : snapshot.status,
    quote: {
      instrument: 'XAUUSD',
      bybitSymbol: 'XAUUSD+',
      bid,
      ask,
      mid,
      timestamp,
      stale: rawQuote.stale,
    },
  };
}

export function parseSseFrames(buffer) {
  const normalized = String(buffer).replaceAll('\r\n', '\n');
  const frames = normalized.split('\n\n');
  const remainder = frames.pop() ?? '';
  const events = [];

  for (const frame of frames) {
    if (!frame || frame.startsWith(':')) continue;
    let event = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }

  return { events, remainder };
}

const validateRelayUrl = (url) => {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
    parsed.pathname !== '/api/quotes'
  ) {
    throw new Error('Bybit relay URL must be a loopback /api/quotes endpoint.');
  }
  return parsed.toString();
};

export function createBybitQuoteRelayClient({
  url = DEFAULT_RELAY_URL,
  fetchImpl = globalThis.fetch,
  onQuote = () => {},
  onStatus = () => {},
  onError = () => {},
  reconnectBaseMs = 1_000,
  reconnectMaxMs = 15_000,
} = {}) {
  const relayUrl = validateRelayUrl(url);
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required.');
  if (
    !Number.isInteger(reconnectBaseMs) ||
    reconnectBaseMs < 1 ||
    !Number.isInteger(reconnectMaxMs) ||
    reconnectMaxMs < reconnectBaseMs
  ) {
    throw new Error('Invalid reconnect bounds.');
  }

  let stopped = true;
  let controller;
  let reconnectTimer;
  let reconnectAttempt = 0;

  const emitError = (error) => {
    const message = error instanceof Error ? error.message : 'Bybit relay failed.';
    onError({ status: 'error', message });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
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

  const consume = async (response) => {
    if (!response.ok) throw new Error(`Bybit relay returned HTTP ${response.status}.`);
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
      throw new Error('Bybit relay returned an unexpected content type.');
    }
    if (!response.body) throw new Error('Bybit relay returned an empty stream.');

    reconnectAttempt = 0;
    onStatus({ status: 'connected' });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_BUFFER_BYTES) {
        throw new Error('Bybit relay SSE buffer exceeded its limit.');
      }
      const parsed = parseSseFrames(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        if (event.event !== 'snapshot') continue;
        const snapshot = parseBybitRelaySnapshot(event.data);
        if (!snapshot) throw new Error('Bybit relay sent an invalid snapshot.');
        onStatus({ status: snapshot.status });
        if (snapshot.quote) onQuote(snapshot.quote);
      }
    }
  };

  async function connect() {
    if (stopped) return;
    controller = new AbortController();
    onStatus({ status: reconnectAttempt > 0 ? 'reconnecting' : 'connecting' });
    try {
      const response = await fetchImpl(relayUrl, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        redirect: 'error',
        signal: controller.signal,
      });
      await consume(response);
      if (!stopped) scheduleReconnect();
    } catch (error) {
      if (stopped || error?.name === 'AbortError') return;
      emitError(error);
      scheduleReconnect();
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      controller?.abort();
      controller = undefined;
    },
  };
}

