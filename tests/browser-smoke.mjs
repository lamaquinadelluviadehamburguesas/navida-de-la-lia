import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Connect to an already running Edge/Chrome instance with remote debugging enabled. */
export async function connectBrowser({
  endpoint = process.env.SMOKE_CDP_URL || 'http://127.0.0.1:9341',
  timeoutMs = 12_000,
  targetId
} = {}) {
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`CDP target discovery failed: HTTP ${response.status}`);
  const targets = await response.json();
  const target = targets.find(item => item.type === 'page' && (!targetId || item.id === targetId));
  if (!target?.webSocketDebuggerUrl) throw new Error('No browser page target is available.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out opening the CDP WebSocket.'));
    }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not open the CDP WebSocket.'));
    }, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const diagnostics = { exceptions: [], consoleErrors: [], networkFailures: [], logErrors: [] };
  const failPending = reason => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
  };

  socket.addEventListener('close', () => failPending('The browser disconnected from CDP.'));
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
      return;
    }

    const params = message.params;
    if (message.method === 'Runtime.exceptionThrown') {
      diagnostics.exceptions.push(params.exceptionDetails);
    } else if (message.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      diagnostics.consoleErrors.push(params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
    } else if (message.method === 'Network.loadingFailed') {
      diagnostics.networkFailures.push({
        type: params.type, error: params.errorText, canceled: Boolean(params.canceled)
      });
    } else if (message.method === 'Log.entryAdded' && params.entry.level === 'error') {
      diagnostics.logErrors.push(params.entry.text);
    }
  });

  function send(method, params = {}, commandTimeoutMs = timeoutMs) {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP socket is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out after ${commandTimeoutMs} ms: ${method}`));
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression, { timeout = timeoutMs, awaitPromise = true } = {}) {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true
    }, timeout);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'Browser evaluation failed.');
    }
    return result.result?.value;
  }

  async function waitFor(expression, { timeout = 20_000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await evaluate(expression, { timeout: Math.min(timeoutMs, deadline - Date.now()) });
        if (value) return value;
      } catch (error) { lastError = error; }
      await delay(interval);
    }
    throw new Error(`Timed out waiting for ${expression}${lastError ? ` (${lastError.message})` : ''}`);
  }

  async function resize(width, height, { mobile = false, deviceScaleFactor = 1 } = {}) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, mobile, deviceScaleFactor });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  }

  async function click(selector) {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('Element is not visible.');
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit !== element && !element.contains(hit)) throw new Error('Element is covered by another element.');
      return { x, y };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }

  async function key(keyValue, code = keyValue, { modifiers = 0 } = {}) {
    const virtualKey = { Enter: 13, Tab: 9, Escape: 27, ' ': 32, ArrowDown: 40, ArrowUp: 38 }[keyValue];
    const params = { key: keyValue, code, modifiers,
      ...(virtualKey ? { windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey } : {}) };
    const text = keyValue === 'Enter' ? '\r' : keyValue === ' ' ? ' ' : undefined;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params,
      ...(text ? { text, unmodifiedText: text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  }

  async function snapshot() {
    return evaluate(`(() => {
      const rect = element => {
        const r = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { x: r.x, y: r.y, width: r.width, height: r.height,
          visible: Boolean(r.width && r.height && style.visibility !== 'hidden' && style.display !== 'none') };
      };
      return {
        url: location.href, readyState: document.readyState, title: document.title,
        viewport: { width: innerWidth, height: innerHeight }, dataset: { ...document.body.dataset },
        canvas: Boolean(document.querySelector('canvas')), loader: Boolean(document.querySelector('#loader')),
        controls: [...document.querySelectorAll('button, input[type="file"]')].map(element => ({
          id: element.id, text: element.textContent.trim(), disabled: element.disabled,
          expanded: element.getAttribute('aria-expanded'), ...rect(element)
        })),
        status: [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
          .map(element => ({ id: element.id, text: element.textContent.trim() })),
        photoCount: window.particleSystem?.filter(particle => particle.type === 'PHOTO').length
      };
    })()`);
  }

  async function screenshot(path) {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (path) await writeFile(path, Buffer.from(result.data, 'base64'));
    return result.data;
  }

  await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);

  return {
    target, diagnostics, send, evaluate, waitFor, resize, click, key, snapshot, screenshot,
    async navigate(url) {
      diagnostics.exceptions.length = 0;
      diagnostics.consoleErrors.length = 0;
      diagnostics.networkFailures.length = 0;
      diagnostics.logErrors.length = 0;
      const result = await send('Page.navigate', { url });
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      return result;
    },
    close() { failPending('CDP session closed by the smoke helper.'); socket.close(); }
  };
}

/** Run normal application startup, including any configured Firebase synchronization. */
export async function runStartupSmoke({
  url = process.env.SMOKE_URL || 'http://127.0.0.1:5173/',
  screenshotPath = process.env.SMOKE_SCREENSHOT
} = {}) {
  const browser = await connectBrowser();
  try {
    await browser.resize(1440, 900);
    await browser.navigate(url);
    await browser.waitFor("document.readyState === 'complete' && Boolean(window.STATE) && Boolean(document.querySelector('canvas'))");
    await delay(1200);
    const result = { snapshot: await browser.snapshot(), diagnostics: browser.diagnostics };
    if (screenshotPath) await browser.screenshot(screenshotPath);
    return result;
  } finally { browser.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runStartupSmoke().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.diagnostics.exceptions.length) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
