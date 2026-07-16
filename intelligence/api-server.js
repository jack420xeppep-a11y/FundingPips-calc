import { createServer } from 'node:http';

const DEFAULT_MAX_CLIENTS = 100;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1_024;

const JSON_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
});

const numericParameter = (params, name, { minimum, maximum }) => {
  const raw = params.get(name);
  const value = Number(raw);
  if (raw === null || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
};

export function parseIntelligenceSetup(params) {
  if (!(params instanceof URLSearchParams)) {
    throw new Error('Setup query is invalid.');
  }
  const instrument = params.get('instrument');
  if (instrument !== 'XAUUSD') throw new Error('HL Intelligence v1 is gold-only.');
  const stage = params.get('stage');
  if (!['p1', 'p2', 'funded'].includes(stage)) throw new Error('stage is invalid.');
  const intent = params.get('intent');
  if (
    !['transfer-to-bybit', 'transfer-to-fundingpips', 'best-expected-value']
      .includes(intent)
  ) {
    throw new Error('intent is invalid.');
  }

  return {
    instrument,
    entryPrice: numericParameter(params, 'entryPrice', {
      minimum: 100,
      maximum: 100_000,
    }),
    slPct: numericParameter(params, 'slPct', { minimum: 0.01, maximum: 10 }),
    rrRatio: numericParameter(params, 'rrRatio', { minimum: 0.5, maximum: 10 }),
    stage,
    accountSize: numericParameter(params, 'accountSize', {
      minimum: 1_000,
      maximum: 1_000_000,
    }),
    riskPerTrade: numericParameter(params, 'riskPerTrade', {
      minimum: 0.01,
      maximum: 20,
    }),
    fundedRisk: numericParameter(params, 'fundedRisk', {
      minimum: 0.01,
      maximum: 20,
    }),
    profitSplit: numericParameter(params, 'profitSplit', {
      minimum: 0.1,
      maximum: 1,
    }),
    bybitStake: numericParameter(params, 'bybitStake', {
      minimum: 0.1,
      maximum: 1_000_000,
    }),
    intent,
  };
}

const formatSse = (event, payload) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

export function createIntelligenceHttpServer({
  getHealth,
  getSnapshot,
  subscribe,
  host = '127.0.0.1',
  port = 8788,
  heartbeatMs = 15_000,
  maxClients = DEFAULT_MAX_CLIENTS,
  maxRequestsPerMinute = 600,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  now = Date.now,
} = {}) {
  if (!getHealth || !getSnapshot || !subscribe) {
    throw new Error('Intelligence HTTP dependencies are required.');
  }
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new Error('Intelligence API must bind to loopback.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Intelligence API port is invalid.');
  }
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 1_000) {
    throw new Error('maxClients must be between 1 and 1000.');
  }
  if (
    !Number.isInteger(maxRequestsPerMinute) ||
    maxRequestsPerMinute < 1 ||
    maxRequestsPerMinute > 60_000
  ) {
    throw new Error('maxRequestsPerMinute must be between 1 and 60000.');
  }
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1_024 ||
    maxResponseBytes > 2 * 1_024 * 1_024
  ) {
    throw new Error('maxResponseBytes is invalid.');
  }

  const clients = new Map();
  let listening = false;
  let requestWindowStartedAt = now();
  let predictionRequestCount = 0;

  const consumePredictionRequest = () => {
    const current = now();
    if (current - requestWindowStartedAt >= 60_000) {
      requestWindowStartedAt = current;
      predictionRequestCount = 0;
    }
    if (predictionRequestCount >= maxRequestsPerMinute) return false;
    predictionRequestCount += 1;
    return true;
  };

  const serialize = (payload) => {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) {
      throw new Error('Aggregate intelligence response exceeded its limit.');
    }
    return body;
  };

  const sendJson = (response, statusCode, payload, extraHeaders = {}) => {
    let body;
    try {
      body = serialize(payload);
    } catch {
      statusCode = 503;
      body = JSON.stringify({
        error: {
          code: 'RESPONSE_LIMIT',
          message: 'Intelligence response is temporarily unavailable.',
        },
      });
    }
    response.writeHead(statusCode, { ...JSON_HEADERS, ...extraHeaders });
    response.end(body);
  };

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

  const removeClient = (response) => {
    const client = clients.get(response);
    if (!client) return;
    client.unsubscribe();
    clients.delete(response);
  };

  const heartbeatTimer = setInterval(() => {
    for (const client of clients.values()) writeClient(client, ': keepalive\n\n');
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  const server = createServer((request, response) => {
    if ((request.url?.length ?? 0) > 4_096) {
      sendJson(response, 414, {
        error: { code: 'URI_TOO_LONG', message: 'Request URI is too long.' },
      });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const knownPath = [
      '/api/intelligence/health',
      '/api/intelligence/snapshot',
      '/api/intelligence/stream',
    ].includes(pathname);
    if (knownPath && request.method !== 'GET') {
      sendJson(response, 405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed.' },
      }, { Allow: 'GET' });
      return;
    }

    if (pathname === '/api/intelligence/health') {
      try {
        const data = getHealth();
        sendJson(response, data.status === 'error' ? 503 : 200, { data });
      } catch {
        sendJson(response, 503, {
          error: { code: 'HEALTH_UNAVAILABLE', message: 'Health state is unavailable.' },
        });
      }
      return;
    }

    if (
      ['/api/intelligence/snapshot', '/api/intelligence/stream'].includes(pathname) &&
      !consumePredictionRequest()
    ) {
      sendJson(response, 429, {
        error: {
          code: 'RATE_LIMITED',
          message: 'Intelligence request budget is temporarily exhausted.',
        },
      }, { 'Retry-After': '60' });
      return;
    }

    if (pathname === '/api/intelligence/snapshot') {
      try {
        const setup = parseIntelligenceSetup(url.searchParams);
        sendJson(response, 200, { data: getSnapshot(setup) });
      } catch (error) {
        const invalid = /invalid|must|gold-only|between|required/i.test(error?.message ?? '');
        sendJson(response, invalid ? 400 : 503, invalid ? {
          error: { code: 'INVALID_SETUP', message: error.message.slice(0, 240) },
        } : {
          error: { code: 'SNAPSHOT_UNAVAILABLE', message: 'Prediction is unavailable.' },
        });
      }
      return;
    }

    if (pathname === '/api/intelligence/stream') {
      if (clients.size >= maxClients) {
        sendJson(response, 503, {
          error: { code: 'CLIENT_LIMIT', message: 'Intelligence client limit reached.' },
        }, { 'Retry-After': '5' });
        return;
      }
      let setup;
      try {
        setup = parseIntelligenceSetup(url.searchParams);
      } catch (error) {
        sendJson(response, 400, {
          error: { code: 'INVALID_SETUP', message: error.message.slice(0, 240) },
        });
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

      const client = {
        response,
        blocked: false,
        pending: null,
        unsubscribe: () => {},
      };
      clients.set(response, client);
      try {
        writeClient(client, formatSse('snapshot', getSnapshot(setup)));
        client.unsubscribe = subscribe(() => {
          try {
            const frame = formatSse('snapshot', getSnapshot(setup));
            if (Buffer.byteLength(frame, 'utf8') <= maxResponseBytes) {
              writeClient(client, frame);
            }
          } catch {
            writeClient(client, formatSse('status', {
              version: 1,
              status: 'degraded',
              message: 'Prediction refresh failed; manual mode remains available.',
            }));
          }
        });
      } catch {
        removeClient(response);
        response.end();
        return;
      }
      request.on('close', () => removeClient(response));
      return;
    }

    sendJson(response, 404, {
      error: { code: 'NOT_FOUND', message: 'Intelligence endpoint not found.' },
    });
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 0;

  return {
    async listen() {
      if (listening) throw new Error('Intelligence API is already listening.');
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
      listening = true;
      const address = server.address();
      return `http://${host}:${address.port}`;
    },
    async close() {
      clearInterval(heartbeatTimer);
      for (const client of clients.values()) {
        client.unsubscribe();
        client.response.end();
      }
      clients.clear();
      if (!listening) return;
      await new Promise((resolve) => server.close(resolve));
      listening = false;
    },
  };
}
