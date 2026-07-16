const RELAY_URL = '/api/quotes';
const RELAY_STATUSES = new Set([
  'connecting',
  'connected',
  'live',
  'reconnecting',
  'stale',
  'error',
]);
const RELAY_SYMBOLS = Object.freeze({
  EURUSD: 'EURUSD+',
  GBPUSD: 'GBPUSD+',
  XAUUSD: 'XAUUSD+',
});

const isPositiveNumber = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function parseQuoteRelayMessage(payload) {
  let message;
  try {
    message = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }

  if (
    message?.version !== 1 ||
    !RELAY_STATUSES.has(message.status) ||
    !Array.isArray(message.quotes) ||
    message.quotes.length > 3
  ) {
    return null;
  }

  const quotes = message.quotes.flatMap((quote) => {
    if (RELAY_SYMBOLS[quote?.instrument] !== quote?.bybitSymbol) return [];
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);
    const mid = Number(quote.mid);
    const timestamp = Number(quote.timestamp);
    if (
      !isPositiveNumber(bid) ||
      !isPositiveNumber(ask) ||
      ask < bid ||
      !isPositiveNumber(mid) ||
      mid < bid ||
      mid > ask ||
      !isPositiveNumber(timestamp) ||
      typeof quote.stale !== 'boolean'
    ) {
      return [];
    }

    return [{
      instrument: quote.instrument,
      bybitSymbol: quote.bybitSymbol,
      bid,
      ask,
      price: mid,
      timestamp,
      stale: quote.stale,
      source: 'CalcPro Quote Relay',
    }];
  });

  return {
    status: message.status,
    quotes,
    ...(typeof message.message === 'string' ? { message: message.message.slice(0, 240) } : {}),
  };
}

export function createQuoteRelayFeed({
  onQuotes = () => {},
  onStatus = () => {},
  onError = () => {},
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  let source;
  let stopped = true;

  const handleSnapshot = (event) => {
    const snapshot = parseQuoteRelayMessage(event.data);
    if (!snapshot) {
      onError({ status: 'error', message: 'Quote Relay прислал некорректные данные.' });
      return;
    }
    if (snapshot.quotes.length > 0) onQuotes(snapshot.quotes);
    onStatus({ status: snapshot.status, message: snapshot.message ?? '' });
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      if (typeof EventSourceImpl !== 'function') {
        onError({ status: 'error', message: 'SSE недоступен в этом браузере.' });
        return;
      }

      onStatus({ status: 'connecting' });
      source = new EventSourceImpl(RELAY_URL);
      source.addEventListener('open', () => {
        if (!stopped) onStatus({ status: 'connected' });
      });
      source.addEventListener('snapshot', (event) => {
        if (!stopped) handleSnapshot(event);
      });
      source.addEventListener('error', () => {
        if (!stopped) onStatus({ status: 'reconnecting' });
      });
    },
    stop() {
      stopped = true;
      source?.close();
      source = undefined;
    },
  };
}
