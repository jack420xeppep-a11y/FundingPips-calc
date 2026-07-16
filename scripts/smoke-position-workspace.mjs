import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = await mkdtemp(join(tmpdir(), 'calcpro-smoke-'));
const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const screenshotPath = process.argv[3] ?? join(tmpdir(), 'calcpro-mobile-smoke.png');
const desktopScreenshotPath = process.argv[4] ??
  join(tmpdir(), 'calcpro-desktop-smoke.png');

const chrome = spawn(chromePath, [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let chromeErrors = '';
chrome.stderr.on('data', (chunk) => {
  chromeErrors += chunk.toString();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

let socket;
try {
  const port = await retry(async () => {
    const activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
    const value = Number(activePort.split('\n')[0]);
    if (!Number.isInteger(value)) throw new Error('Chrome did not publish a debugging port');
    return value;
  }, 200).catch((error) => {
    throw new Error(`Chrome did not start: ${chromeErrors || error.message}`);
  });

  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
    const targets = await response.json();
    const page = targets.find((item) => item.type === 'page');
    if (!page) throw new Error('No Chrome page target');
    return page;
  });

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const cdp = new CdpClient(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Browser.grantPermissions', {
    origin: new URL(url).origin,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send('Page.navigate', { url });
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        'Browser evaluation failed',
      );
    }
    return response.result.value;
  };

  await retry(async () => {
    const ready = await evaluate(
      "document.querySelector('#root')?.innerText.includes('Execution sizing')",
    );
    if (!ready) throw new Error('Position workspace is not ready');
  }, 80);

  const quickMode = await evaluate(`(() => ({
    advancedHidden: getComputedStyle(document.querySelector('.advanced-content')).display === 'none',
    riskHidden: getComputedStyle(document.querySelector('.risk-rail')).display === 'none',
    copyVisible: getComputedStyle(document.querySelector('.copy-trade')).display !== 'none',
    controlCount: document.querySelectorAll('.input-rail .field').length,
    advancedExpanded: document.querySelector('.mobile-advanced-toggle').getAttribute('aria-expanded'),
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
  }))()`);

  await evaluate(`(() => {
    document.querySelector('.copy-trade').click();
    return true;
  })()`);
  await retry(async () => {
    const copied = await evaluate(
      "document.querySelector('.copy-trade').innerText.includes('Значения скопированы')",
    );
    if (!copied) throw new Error('Copy action did not complete');
  });
  const copyWorked = await evaluate(`(async () => {
    const copiedText = await navigator.clipboard.readText();
    return copiedText.includes('BYBIT · SHORT') &&
      copiedText.includes('FUNDINGPIPS · LONG');
  })()`);

  await evaluate("document.querySelector('.mobile-advanced-toggle').click()");
  await delay(200);
  const advancedVisible = await evaluate(
    "getComputedStyle(document.querySelector('.advanced-content')).display !== 'none'",
  );

  await evaluate(`(() => {
    const select = document.querySelector('#strategy-goal');
    select.value = 'minimum-funded-tp';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await delay(100);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.includes('Подобрать параметры'));
    button.click();
    return true;
  })()`);

  await retry(async () => {
    const ready = await evaluate(
      "document.querySelector('.optimizer-result')?.innerText.includes('5.36%')",
    );
    if (!ready) throw new Error('Optimizer result is not ready');
  });

  await evaluate("document.querySelector('.optimizer-result .secondary-action').click()");
  await delay(150);
  const optimizer = await evaluate(`(() => ({
    fundedStake: document.querySelector('#bybitFunded').value,
    breakEvenText: document.querySelector('.break-even-block').innerText,
  }))()`);

  await evaluate("document.querySelector('.mobile-advanced-toggle').click()");
  await delay(100);
  await evaluate(`(() => {
    const select = document.querySelector('#instrument');
    select.value = 'XAUUSD';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await delay(150);
  const gold = await evaluate(`(() => ({
    instrument: document.querySelector('#instrument').value,
    entryPrice: document.querySelector('#entryPrice').value,
    resultVisible: getComputedStyle(document.querySelector('.position-grid')).display !== 'none',
    advancedHidden: getComputedStyle(document.querySelector('.advanced-content')).display === 'none',
  }))()`);

  await evaluate("document.querySelector('#auto-price').click()");
  await retry(async () => {
    const ready = await evaluate(`(() =>
      document.querySelector('.live-price-status')?.innerText.includes('LIVE') &&
      Number(document.querySelector('#entryPrice').value) > 3000
    )()`);
    if (!ready) throw new Error('XAUUSD+ live price is not ready');
  }, 200);
  const goldLive = await evaluate(`(() => ({
    value: Number(document.querySelector('#entryPrice').value),
    readOnly: document.querySelector('#entryPrice').readOnly,
    status: document.querySelector('.live-price-status').innerText,
  }))()`);

  await evaluate("document.querySelector('#hl-intelligence').click()");
  await retry(async () => {
    const ready = await evaluate(`(() => {
      const panel = document.querySelector('.intelligence-panel');
      return panel &&
        panel.querySelectorAll('.intelligence-path').length === 3 &&
        panel.innerText.includes('BB TP / FP SL') &&
        panel.innerText.includes('BB SL / FP TP');
    })()`);
    if (!ready) throw new Error('HL Intelligence aggregate panel is not ready');
  }, 300);
  const intelligence = await evaluate(`(() => {
    const probabilities = [...document.querySelectorAll('.intelligence-path strong')]
      .map((node) => Number(node.innerText.replace('%', '')) / 100);
    return {
      enabled: document.querySelector('#hl-intelligence').checked,
      status: document.querySelector('.intelligence-status').innerText,
      probabilitySum: probabilities.reduce((sum, value) => sum + value, 0),
      recommendation: document.querySelector('.intelligence-recommendation strong').innerText,
      advancedHidden:
        getComputedStyle(document.querySelector('.intelligence-advanced')).display === 'none',
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  })()`);

  await evaluate("document.querySelector('.copy-trade').click()");
  await retry(async () => {
    const locked = await evaluate(
      "document.querySelector('.intelligence-status')?.innerText.includes('LOCKED')",
    );
    const noEdge = await evaluate(
      "document.querySelector('.intelligence-status')?.innerText.includes('NO EDGE')",
    );
    if (!locked && !noEdge) throw new Error('Copy did not lock HL Intelligence AUTO');
  });
  const lockButtonExists = await evaluate(
    "Boolean(document.querySelector('.intelligence-lock'))",
  );
  if (lockButtonExists) {
    await evaluate("document.querySelector('.intelligence-lock').click()");
    await retry(async () => {
      const unlocked = await evaluate(
        "!document.querySelector('.intelligence-status')?.innerText.includes('LOCKED')",
      );
      if (!unlocked) throw new Error('HL Intelligence unlock did not apply');
    });
  }
  const intelligenceUnlocked = await evaluate(`(() => {
    const button = document.querySelector('.intelligence-lock');
    return button
      ? button.innerText.includes('Зафиксировать')
      : document.querySelector('.intelligence-recommendation')
        .innerText.includes('MANUAL DIRECTION');
  })()`);
  await retry(async () => {
    const synchronized = await evaluate(`(() => {
      const status = document.querySelector('.intelligence-status')?.innerText ?? '';
      const recommendation =
        document.querySelector('.intelligence-recommendation strong')?.innerText ?? '';
      if (status.includes('NO EDGE')) return true;
      const expected = recommendation.includes('FP SHORT')
        ? 'short'
        : recommendation.includes('FP LONG')
          ? 'long'
          : null;
      return expected && document.querySelector('#fpDirection').value === expected;
    })()`);
    if (!synchronized) throw new Error('AUTO direction did not synchronize after unlock');
  }, 100);
  const intelligenceDirectionSynchronized = await evaluate(`(() => {
    const recommendation =
      document.querySelector('.intelligence-recommendation strong')?.innerText ?? '';
    const expected = recommendation.includes('FP SHORT')
      ? 'short'
      : recommendation.includes('FP LONG')
        ? 'long'
        : document.querySelector('#fpDirection').value;
    return document.querySelector('#fpDirection').value === expected;
  })()`);

  const mobileScreenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(screenshotPath, Buffer.from(mobileScreenshot.data, 'base64'));

  await evaluate(`(() => {
    const select = document.querySelector('#instrument');
    select.value = 'EURUSD';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await retry(async () => {
    const ready = await evaluate(`(() =>
      document.querySelector('.live-price-status')?.innerText.includes('EURUSD+') &&
      Number(document.querySelector('#entryPrice').value) !== 1.1559
    )()`);
    if (!ready) throw new Error('EURUSD+ live price is not ready');
  });
  const euroLive = await evaluate("Number(document.querySelector('#entryPrice').value)");

  await evaluate(`(() => {
    const select = document.querySelector('#instrument');
    select.value = 'GBPUSD';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await retry(async () => {
    const ready = await evaluate(`(() =>
      document.querySelector('.live-price-status')?.innerText.includes('GBPUSD+') &&
      Number(document.querySelector('#entryPrice').value) !== 1.333
    )()`);
    if (!ready) throw new Error('GBPUSD+ live price is not ready');
  });
  const poundLive = await evaluate("Number(document.querySelector('#entryPrice').value)");

  const networkUrls = cdp.events.flatMap((event) => {
    if (event.method === 'Network.requestWillBeSent') {
      return [event.params.request.url];
    }
    if (event.method === 'Network.webSocketCreated') {
      return [event.params.url];
    }
    return [];
  });
  const quoteTransport = {
    usedRelay: networkUrls.some((requestUrl) => requestUrl.includes('/api/quotes')),
    usedIntelligenceRelay: networkUrls.some((requestUrl) =>
      requestUrl.includes('/api/intelligence/stream')),
    openedDirectBybitSocket: networkUrls.some((requestUrl) =>
      requestUrl.includes('ws2.bybit.com/realtime_w')),
    openedDirectHyperliquidSocket: networkUrls.some((requestUrl) =>
      requestUrl.includes('api.hyperliquid.xyz/ws')),
  };

  await evaluate("document.querySelector('.theme-toggle').click()");
  await delay(100);
  const darkTheme = await evaluate(`(() => ({
    selected: document.documentElement.dataset.theme === 'dark',
    canvas: getComputedStyle(document.body).backgroundColor,
  }))()`);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(150);
  await evaluate(`(() => {
    const select = document.querySelector('#instrument');
    select.value = 'XAUUSD';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await retry(async () => {
    const ready = await evaluate(
      "Boolean(document.querySelector('.intelligence-panel .intelligence-paths'))",
    );
    if (!ready) throw new Error('Desktop HL Intelligence panel is not ready');
  }, 200);
  const desktop = await evaluate(`(() => ({
    advancedVisible: getComputedStyle(document.querySelector('.advanced-content')).display !== 'none',
    riskVisible: getComputedStyle(document.querySelector('.risk-rail')).display !== 'none',
    strategyVisible: getComputedStyle(document.querySelector('.strategy-lab')).display !== 'none',
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
  }))()`);
  const desktopScreenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(
    desktopScreenshotPath,
    Buffer.from(desktopScreenshot.data, 'base64'),
  );

  const errors = cdp.events
    .filter((event) => event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Log.entryAdded' && event.params.entry.level === 'error'))
    .map((event) => event.params.exceptionDetails?.exception?.description ??
      event.params.exceptionDetails?.text ?? event.params.entry?.text);

  const passed = quickMode.advancedHidden &&
    quickMode.riskHidden &&
    quickMode.copyVisible &&
    quickMode.controlCount === 5 &&
    quickMode.advancedExpanded === 'false' &&
    quickMode.noHorizontalOverflow &&
    copyWorked === true &&
    advancedVisible &&
    optimizer.fundedStake === '28' &&
    optimizer.breakEvenText.includes('5.36%') &&
    gold.instrument === 'XAUUSD' &&
    gold.entryPrice === '2900' &&
    gold.resultVisible &&
    gold.advancedHidden &&
    goldLive.value > 3000 &&
    goldLive.readOnly &&
    goldLive.status.includes('XAUUSD+') &&
    intelligence.enabled &&
    intelligence.probabilitySum >= 0.98 &&
    intelligence.probabilitySum <= 1.02 &&
    (intelligence.recommendation.includes('FP') ||
      intelligence.recommendation.includes('MANUAL DIRECTION')) &&
    intelligence.advancedHidden &&
    intelligence.noHorizontalOverflow &&
    intelligenceUnlocked &&
    intelligenceDirectionSynchronized &&
    euroLive > 0 &&
    poundLive > 0 &&
    quoteTransport.usedRelay &&
    quoteTransport.usedIntelligenceRelay &&
    !quoteTransport.openedDirectBybitSocket &&
    !quoteTransport.openedDirectHyperliquidSocket &&
    darkTheme.selected &&
    darkTheme.canvas !== 'rgb(255, 255, 255)' &&
    desktop.advancedVisible &&
    desktop.riskVisible &&
    desktop.strategyVisible &&
    desktop.noHorizontalOverflow &&
    errors.length === 0;

  console.log(JSON.stringify({
    passed,
    quickMode,
    copyWorked,
    advancedVisible,
    optimizer,
    gold,
    livePrices: { gold: goldLive, euro: euroLive, pound: poundLive },
    intelligence,
    intelligenceUnlocked,
    intelligenceDirectionSynchronized,
    quoteTransport,
    darkTheme,
    desktop,
    screenshotPath,
    desktopScreenshotPath,
    errors,
  }, null, 2));
  process.exitCode = passed ? 0 : 1;
} finally {
  socket?.close();
  if (chrome.exitCode === null) {
    const exited = new Promise((resolveExit) => chrome.once('exit', resolveExit));
    chrome.kill('SIGTERM');
    await Promise.race([exited, delay(2_000)]);
  }
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
