import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = await mkdtemp(join(tmpdir(), 'calcpro-repro-'))
const url = process.argv[2] ?? 'https://farmcalc.duckdns.org/'

const chrome = spawn(chromePath, [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--remote-debugging-port=0',
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
let chromeErrors = ''
chrome.stderr.on('data', (chunk) => {
  chromeErrors += chunk.toString()
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function retry(fn, attempts = 40) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw lastError
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error.message))
        else pending.resolve(message.result)
        return
      }
      this.events.push(message)
    })
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
}

let socket
try {
  let port
  try {
    port = await retry(async () => {
      const activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
      const value = Number(activePort.split('\n')[0])
      if (!Number.isInteger(value)) throw new Error('Chrome did not publish a debugging port')
      return value
    })
  } catch (error) {
    throw new Error(`Chrome did not start: ${chromeErrors || error.message}`)
  }

  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`)
    const targets = await response.json()
    const page = targets.find((item) => item.type === 'page')
    if (!page) throw new Error('No Chrome page target')
    return page
  })

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  const cdp = new CdpClient(socket)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.navigate', { url })

  await retry(async () => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: "document.querySelector('#root')?.innerText.includes('Лестница восстановления')",
      returnByValue: true,
    })
    if (!result.result.value) throw new Error('Application is not ready')
  }, 80)

  const click = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.innerText.includes('Лестница восстановления'))
      if (!button) return false
      button.click()
      return true
    })()`,
    returnByValue: true,
  })

  if (!click.result.value) throw new Error('Recovery tab button was not found')
  await delay(300)

  const selectGold = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const select = [...document.querySelectorAll('select')]
        .find((item) => [...item.options].some((option) => option.value === 'XAUUSD'))
      if (!select) return false
      select.value = 'XAUUSD'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`,
    returnByValue: true,
  })

  if (!selectGold.result.value) throw new Error('XAUUSD instrument selector was not found')
  await delay(300)

  const state = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      rootText: document.querySelector('#root')?.innerText.trim() ?? '',
      bodyText: document.body.innerText.trim(),
      rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
    }))()`,
    returnByValue: true,
  })

  const errors = cdp.events
    .filter((event) => event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Log.entryAdded' && event.params.entry.level === 'error'))
    .map((event) => event.params.exceptionDetails?.exception?.description ??
      event.params.exceptionDetails?.text ?? event.params.entry?.text)

  const result = state.result.value
  const passed = result.rootText.length > 100 &&
    result.rootText.includes('XAUUSD') &&
    result.rootChildren > 0 &&
    errors.length === 0
  console.log(JSON.stringify({ passed, ...result, errors }, null, 2))
  process.exitCode = passed ? 0 : 1
} finally {
  socket?.close()
  chrome.kill('SIGTERM')
  await rm(profile, { recursive: true, force: true })
}
