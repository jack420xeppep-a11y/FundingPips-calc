import {
  createBybitTradfiUpstream,
  createQuoteRelayHttpServer,
  createQuoteStore,
} from './quote-relay.js';

const integerFromEnv = (name, fallback, { min, max }) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
};

const host = process.env.RELAY_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1'].includes(host)) {
  throw new Error('RELAY_HOST must be a loopback address.');
}

const port = integerFromEnv('RELAY_PORT', 8787, { min: 1_024, max: 65_535 });
const staleAfterMs = integerFromEnv('QUOTE_STALE_AFTER_MS', 10_000, {
  min: 1_000,
  max: 60_000,
});
const maxClients = integerFromEnv('RELAY_MAX_CLIENTS', 100, { min: 1, max: 1_000 });

const store = createQuoteStore({ staleAfterMs });
const relay = createQuoteRelayHttpServer({ store, host, port, maxClients });
const upstream = createBybitTradfiUpstream({
  onQuotes: (quotes) => store.applyQuotes(quotes),
  onStatus: ({ status }) => store.setStatus(status),
  onError: ({ message }) => store.setStatus('error', message),
});

const address = await relay.listen();
upstream.start();
console.log(JSON.stringify({ event: 'quote_relay_started', address, staleAfterMs, maxClients }));

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'quote_relay_stopping', signal }));
  upstream.stop();
  await relay.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
