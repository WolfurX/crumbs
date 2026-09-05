// Minimal Chrome DevTools Protocol client on Node's built-in WebSocket. Used by the e2e scripts.
export async function connect(port = 9222, match = () => true) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && match(t))
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => [t.type, t.url])))
  return attach(page.webSocketDebuggerUrl)
}

export function attach(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const listeners = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
    }
  })
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = async (method, params = {}) => {
    await ready
    const myId = ++id
    return new Promise((resolve, reject) => {
      pending.set(myId, { resolve, reject })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })
  }
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn])
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
    return r.result.value
  }
  const waitFor = async (expr, timeout = 15000, every = 200) => {
    const t0 = Date.now()
    for (;;) {
      const v = await evaluate(expr).catch(() => undefined)
      if (v) return v
      if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for: ${expr}`)
      await new Promise((r) => setTimeout(r, every))
    }
  }
  const screenshot = async (path) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    await import('node:fs').then((fs) => fs.promises.writeFile(path, Buffer.from(data, 'base64')))
  }
  return { send, on, evaluate, waitFor, screenshot, close: () => ws.close() }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
