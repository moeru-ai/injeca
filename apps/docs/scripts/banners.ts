// Renders the README banners, in the dark and the light theme, as animated WebP in docs/assets/banners.
// It builds the page and serves it with vite preview. Each banner is ?capture=<scene> in headless Chrome, driven
// through the DevTools protocol, as in moeru-ai/ergosphere-it: the page lists its frames in `__captureFrames` (how
// long each one shows), `__captureAt(i)` draws frame i, and img2webp joins the screenshots into a looping WebP.
// The lab runs injeca in the page, so each frame shows the behavior of the source.
//
//   pnpm -F @injeca/docs banners
//
// CHROME points to another Chrome binary. img2webp must be on PATH (brew install webp).

import process from 'node:process'

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { build, preview } from 'vite'

import { CAPTURE_SIZES } from '../src/capture.ts'

// Async, so the preview server in this process keeps answering while Chrome loads the page.
const run = promisify(execFile)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '..', '..', 'docs', 'assets', 'banners')
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const THEMES = ['dark', 'light'] as const

/**
 * How each scene renders. The hero has many frames of 3D shading, so it renders at 1x and lossy. A comparison has a
 * few frames of text and flat fills, so it renders at 2x, sharp on a Retina screen.
 */
function settingsOf(scene: string): { query: string, scale: number, quality: string[] } {
  if (scene === 'hero')
    return { query: 'capture=hero&animate', scale: 1, quality: ['-lossy', '-q', '82', '-m', '4'] }
  return { query: `capture=${scene}`, scale: 2, quality: ['-lossy', '-q', '90', '-m', '4'] }
}

// A built page, not the dev server: the dev server can reload the page while it optimizes dependencies,
// and headless Chrome then never finishes.
const configFile = join(root, 'vite.config.ts')
await build({ configFile, logLevel: 'error', root })
const server = await preview({ configFile, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 }, root })
const address = server.httpServer.address()
if (!address || typeof address === 'string')
  throw new Error('The Vite server has no port.')
const origin = `http://127.0.0.1:${address.port}`

const work = mkdtempSync(join(tmpdir(), 'injeca-banners-'))
mkdirSync(out, { recursive: true })

/** A minimal client of the Chrome DevTools protocol over the WebSocket that Node has built in. */
class DevTools {
  private next = 0
  private readonly pending = new Map<number, { reject: (error: Error) => void, resolve: (value: any) => void }>()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { error?: { message: string }, id?: number, result?: unknown }
      const waiting = message.id === undefined ? undefined : this.pending.get(message.id)
      if (!waiting)
        return
      this.pending.delete(message.id!)
      if (message.error)
        waiting.reject(new Error(message.error.message))
      else
        waiting.resolve(message.result)
    })
  }

  static async connect(url: string): Promise<DevTools> {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return new DevTools(socket)
  }

  close(): void {
    this.socket.close()
  }

  /** Runs an expression in the page and waits for it when it is a promise. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const { exceptionDetails, result } = await this.send('Runtime.evaluate', { awaitPromise: true, expression, returnByValue: true })
    if (exceptionDetails)
      throw new Error(`The page threw: ${JSON.stringify(exceptionDetails)}`)
    return result.value as T
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.next
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { reject, resolve }))
  }
}

async function animated(scene: string, theme: string): Promise<void> {
  const { height, width } = CAPTURE_SIZES[scene]!
  const { query, scale, quality } = settingsOf(scene)
  const profile = join(work, `profile-${scene}-${theme}`)
  const browser = spawn(chrome, [
    '--headless=new',
    // WebGL in headless Chrome, for the hero scene.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    // Chrome writes the port that it picked into the profile.
    let port: string | undefined
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100)
      try {
        port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]
      }
      catch {}
    }
    if (!port)
      throw new Error('Chrome did not open its DevTools port.')

    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string, webSocketDebuggerUrl: string }[]
    const page = targets.find(t => t.type === 'page')
    if (!page)
      throw new Error('Chrome has no page.')
    const devtools = await DevTools.connect(page.webSocketDebuggerUrl)

    await devtools.send('Emulation.setDeviceMetricsOverride', { deviceScaleFactor: scale, height, mobile: false, width })
    // Transparent around the rounded corners of the banner.
    await devtools.send('Emulation.setDefaultBackgroundColorOverride', { color: { a: 0, b: 0, g: 0, r: 0 } })
    await devtools.send('Page.enable')
    await devtools.send('Page.navigate', { url: `${origin}/?${query}&theme=${theme}` })
    // The page lists its frames once the lab ran every variant and the fonts arrived.
    const durations = await devtools.evaluate<number[]>(`new Promise(async (resolve) => {
      while (!window.__captureFrames) await new Promise(r => setTimeout(r, 50))
      await document.fonts.ready
      resolve(window.__captureFrames)
    })`)

    const args: string[] = ['-loop', '0', ...quality]
    for (const [i, duration] of durations.entries()) {
      await devtools.evaluate(`window.__captureAt(${i}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`)
      const { data } = await devtools.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
      const frame = join(work, `${scene}-${theme}-${String(i).padStart(4, '0')}.png`)
      writeFileSync(frame, Buffer.from(data, 'base64'))
      args.push('-d', String(Math.round(duration)), frame)
    }
    devtools.close()

    const webp = join(out, `${scene}-${theme}.webp`)
    await run('img2webp', [...args, '-o', webp], { maxBuffer: 1 << 26 })
    console.info(webp)
  }
  finally {
    browser.kill()
  }
}

try {
  for (const theme of THEMES) {
    for (const scene of Object.keys(CAPTURE_SIZES))
      await animated(scene, theme)
  }
}
finally {
  await server.close()
  rmSync(work, { force: true, recursive: true })
}
