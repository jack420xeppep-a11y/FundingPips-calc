const INFO_URL = 'https://api.hyperliquid.xyz/info';
const GOLD_COIN = 'xyz:GOLD';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const DEFAULT_MAX_RESPONSE_BYTES = 12 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_FILLS_PAGE_LIMIT = 2_000;
const MAX_FILL_PAGES = 20;
const MAX_GOLD_FILLS = 10_000;

const isPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const isFiniteNumber = (value) => Number.isFinite(Number(value));

const validateAddress = (address) => (
  typeof address === 'string' && ADDRESS_PATTERN.test(address)
);

export function createWeightedRateLimiter({
  capacity = 400,
  refillPerMinute = 400,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (
    !Number.isFinite(capacity) ||
    capacity < 1 ||
    !Number.isFinite(refillPerMinute) ||
    refillPerMinute < 1
  ) {
    throw new Error('Rate limiter capacity and refill must be positive.');
  }

  let tokens = capacity;
  let updatedAt = now();

  const refill = () => {
    const current = now();
    const elapsed = Math.max(0, current - updatedAt);
    tokens = Math.min(capacity, tokens + ((elapsed * refillPerMinute) / 60_000));
    updatedAt = current;
  };

  return {
    async acquire(weight) {
      if (!Number.isFinite(weight) || weight <= 0 || weight > capacity) {
        throw new Error('Requested rate-limit weight is invalid.');
      }
      while (true) {
        refill();
        if (tokens >= weight) {
          tokens -= weight;
          return;
        }
        const missing = weight - tokens;
        const waitMs = Math.max(1, Math.ceil((missing / refillPerMinute) * 60_000));
        await sleep(waitMs);
      }
    },
  };
}

export function normalizeGoldFill(address, fill) {
  if (
    !validateAddress(address) ||
    fill?.coin !== GOLD_COIN ||
    !isPositive(fill.px) ||
    !isPositive(fill.sz) ||
    !['A', 'B'].includes(fill.side) ||
    !Number.isSafeInteger(Number(fill.time)) ||
    Number(fill.time) <= 0 ||
    !isFiniteNumber(fill.startPosition) ||
    typeof fill.dir !== 'string' ||
    fill.dir.length < 1 ||
    fill.dir.length > 80 ||
    !isFiniteNumber(fill.closedPnl) ||
    !HASH_PATTERN.test(fill.hash ?? '') ||
    !Number.isSafeInteger(Number(fill.oid)) ||
    Number(fill.oid) < 0 ||
    typeof fill.crossed !== 'boolean' ||
    !isFiniteNumber(fill.fee ?? 0) ||
    !Number.isSafeInteger(Number(fill.tid)) ||
    Number(fill.tid) < 0
  ) {
    return null;
  }

  return {
    address: address.toLowerCase(),
    coin: GOLD_COIN,
    price: Number(fill.px),
    size: Number(fill.sz),
    side: fill.side,
    timestamp: Number(fill.time),
    startPosition: Number(fill.startPosition),
    direction: fill.dir,
    closedPnl: Number(fill.closedPnl),
    hash: fill.hash.toLowerCase(),
    oid: Number(fill.oid),
    crossed: fill.crossed,
    fee: Number(fill.fee ?? 0),
    tid: Number(fill.tid),
  };
}

export function createHyperliquidInfoClient({
  fetchImpl = globalThis.fetch,
  limiter = createWeightedRateLimiter(),
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fillsPageLimit = DEFAULT_FILLS_PAGE_LIMIT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required.');
  if (!limiter?.acquire) throw new Error('A weighted limiter is required.');
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 64 ||
    maxResponseBytes > 64 * 1_024 * 1_024
  ) {
    throw new Error('maxResponseBytes is invalid.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('timeoutMs is invalid.');
  }
  if (
    !Number.isInteger(fillsPageLimit) ||
    fillsPageLimit < 1 ||
    fillsPageLimit > DEFAULT_FILLS_PAGE_LIMIT
  ) {
    throw new Error('fillsPageLimit is invalid.');
  }

  const request = async (body, weight) => {
    await limiter.acquire(weight);
    const response = await fetchImpl(INFO_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Hyperliquid info returned HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
      throw new Error('Hyperliquid info response exceeded the size limit.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      throw new Error('Hyperliquid info response exceeded the size limit.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Hyperliquid info returned invalid JSON.');
    }
  };

  return {
    async fetchUserGoldFills(address, { startTime, endTime = Date.now() } = {}) {
      if (!validateAddress(address)) throw new Error('Invalid wallet address.');
      if (
        !Number.isSafeInteger(startTime) ||
        startTime <= 0 ||
        !Number.isSafeInteger(endTime) ||
        endTime < startTime
      ) {
        throw new Error('Invalid fill time range.');
      }

      const normalizedAddress = address.toLowerCase();
      const fills = [];
      const keys = new Set();
      let cursor = startTime;

      for (let page = 0; page < MAX_FILL_PAGES && cursor <= endTime; page += 1) {
        const rawFills = await request({
          type: 'userFillsByTime',
          user: normalizedAddress,
          startTime: cursor,
          endTime,
          aggregateByTime: false,
        }, 40);
        if (!Array.isArray(rawFills)) {
          throw new Error('Hyperliquid fills response is not an array.');
        }
        if (rawFills.length === 0) break;
        if (rawFills.length > DEFAULT_FILLS_PAGE_LIMIT) {
          throw new Error('Hyperliquid fills response exceeded the documented page limit.');
        }

        let latestTimestamp = cursor - 1;
        for (const rawFill of rawFills) {
          const timestamp = Number(rawFill?.time);
          if (Number.isSafeInteger(timestamp)) latestTimestamp = Math.max(latestTimestamp, timestamp);
          const normalized = normalizeGoldFill(normalizedAddress, rawFill);
          if (!normalized) continue;
          const key = `${normalized.timestamp}:${normalized.tid}`;
          if (keys.has(key)) continue;
          keys.add(key);
          fills.push(normalized);
          if (fills.length > MAX_GOLD_FILLS) {
            throw new Error('Gold fill history exceeded the documented 10000-fill bound.');
          }
        }

        if (latestTimestamp < cursor) break;
        cursor = latestTimestamp + 1;
        if (rawFills.length < fillsPageLimit) break;
      }

      return fills.sort((left, right) => (
        left.timestamp - right.timestamp || left.tid - right.tid
      ));
    },

    async fetchGoldPosition(address) {
      if (!validateAddress(address)) throw new Error('Invalid wallet address.');
      const state = await request({
        type: 'clearinghouseState',
        user: address.toLowerCase(),
        dex: 'xyz',
      }, 2);
      if (!state || !Array.isArray(state.assetPositions)) {
        throw new Error('Hyperliquid clearinghouse state is invalid.');
      }
      const gold = state.assetPositions.find((item) => item?.position?.coin === GOLD_COIN);
      if (!gold) return null;
      const position = gold.position;
      const signedSize = Number(position.szi);
      if (
        !isFiniteNumber(signedSize) ||
        signedSize === 0 ||
        !isPositive(position.entryPx) ||
        !isFiniteNumber(position.positionValue) ||
        !isFiniteNumber(position.unrealizedPnl)
      ) {
        return null;
      }
      return {
        side: signedSize > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(signedSize),
        signedSize,
        entryPrice: Number(position.entryPx),
        positionValue: Math.abs(Number(position.positionValue)),
        unrealizedPnl: Number(position.unrealizedPnl),
      };
    },
  };
}
