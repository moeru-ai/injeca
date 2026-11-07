// Renders the README banners, in the dark and the light theme, as WebP in docs/assets/banners.
// It builds the page and serves it with vite preview. Each banner is ?capture=<scene> in headless Chrome, driven
// through the DevTools protocol, as in moeru-ai/ergosphere-it. The hero is one still frame. A comparison is animated:
// the page lists its steps in `__captureFrames` (how long each one shows), `__captureAt(i)` moves to step i, and the
// page plays each step in real time while Chrome sends each frame that it renders (a screencast). The frames keep the
// times that Chrome gives them, so the WebP plays at the speed of the page. img2webp joins the frames into a looping
// WebP. The lab runs injeca in the page, so each frame shows the behavior of the source.
//
//   pnpm -F @injeca/docs banners
//
// BANNERS=hero,compare-swap renders only those scenes. CHROME points to another Chrome binary. cwebp and img2webp must be on PATH (brew install webp).

import process from 'node:process'

import { Buffer } from 'node:buffer'
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

/** A comparison renders at 1.5x: sharp enough on a Retina screen, and small enough for some hundred frames. */
const SCALE = 1.5
/** The most frames a second that a comparison keeps. A frame that the page holds longer shows longer. */
const FPS = 15

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
mkdirSync(join(root, 'public'), { recursive: true })

/** A minimal client of the Chrome DevTools protocol over the WebSocket that Node has built in. */
class DevTools {
  private next = 0
  private readonly pending = new Map<number, { reject: (error: Error) => void, resolve: (value: any) => void }>()
  private readonly listeners = new Map<string, Set<(params: any) => void>>()
  private readonly socket: WebSocket

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { error?: { message: string }, id?: number, method?: string, params?: unknown, result?: unknown }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? [])
          listener(message.params)
        return
      }
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

  /** Calls `listener` with the params of each event `method`. */
  on<T = any>(method: string, listener: (params: T) => void): void {
    if (!this.listeners.has(method))
      this.listeners.set(method, new Set())
    this.listeners.get(method)!.add(listener)
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.next
    this.socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { reject, resolve }))
  }
}

/** Opens ?capture=<scene> in a headless Chrome at the size of the scene, and hands its DevTools to `use`. */
async function withPage(scene: string, theme: string, scale: number, use: (devtools: DevTools) => Promise<void>): Promise<void> {
  const { height, width } = CAPTURE_SIZES[scene]!
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
    await devtools.send('Page.navigate', { url: `${origin}/?capture=${scene}&theme=${theme}` })
    // The page is ready once the lab ran every variant and the fonts arrived.
    await devtools.evaluate(`new Promise(async (resolve) => {
      while (!window.__labReady) await new Promise(r => setTimeout(r, 50))
      await document.fonts.ready
      await new Promise(r => setTimeout(r, 300))
      resolve(true)
    })`)
    await use(devtools)
    devtools.close()
  }
  finally {
    browser.kill()
  }
}

async function screenshot(devtools: DevTools, file: string): Promise<string> {
  const { data } = await devtools.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
  writeFileSync(file, Buffer.from(data, 'base64'))
  return file
}

/** The scenes that are one still frame. The others are comparisons, and animated. */
const STILLS = new Set(['hero', 'og', 'features', 'phases'])

/** A still frame at 2x, as WebP. The Open Graph image is a PNG at 1x in the public folder of the page, in the light theme only. */
async function still(scene: string, theme: string): Promise<void> {
  if (scene === 'og') {
    if (theme !== 'light')
      return
    await withPage(scene, theme, 1, async (devtools) => {
      const png = await screenshot(devtools, join(root, 'public', 'og.png'))
      console.info(png)
    })
    return
  }
  await withPage(scene, theme, 2, async (devtools) => {
    const png = await screenshot(devtools, join(work, `${scene}-${theme}.png`))
    const webp = join(out, `${scene}-${theme}.webp`)
    await run('cwebp', ['-quiet', '-q', '92', png, '-o', webp])
    console.info(webp)
  })
}

/** A comparison: each step, and the transitions of the page between steps, as Chrome renders them. */
async function animated(scene: string, theme: string): Promise<void> {
  await withPage(scene, theme, SCALE, async (devtools) => {
    const steps = await devtools.evaluate<number[]>('window.__captureFrames')
    const { height, width } = CAPTURE_SIZES[scene]!

    const frames: { file: string, time: number }[] = []
    let writing = Promise.resolve()
    devtools.on<{ data: string, metadata: { timestamp: number }, sessionId: number }>('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      void devtools.send('Page.screencastFrameAck', { sessionId })
      const file = join(work, `${scene}-${theme}-${String(frames.length).padStart(5, '0')}.png`)
      frames.push({ file, time: metadata.timestamp * 1000 })
      writing = writing.then(() => writeFileSync(file, Buffer.from(data, 'base64')))
    })

    await devtools.evaluate('window.__captureAt(0)')
    await devtools.send('Page.startScreencast', { everyNthFrame: 1, format: 'png', maxHeight: height * SCALE, maxWidth: width * SCALE })
    const begin = Date.now()
    for (const [i, duration] of steps.entries()) {
      if (i > 0)
        await devtools.evaluate(`window.__captureAt(${i})`)
      await sleep(duration)
    }
    await devtools.send('Page.stopScreencast')
    await writing
    const total = Date.now() - begin

    // Keep at most FPS frames a second. Each kept frame shows until the next one, and the last one until the end.
    const kept = frames.reduce<typeof frames>((list, frame) => (list.length === 0 || frame.time - list.at(-1)!.time >= 1000 / FPS ? [...list, frame] : list), [])
    const args: string[] = ['-loop', '0', '-lossless', '-q', '75', '-m', '4']
    for (const [i, frame] of kept.entries()) {
      const next = kept[i + 1]?.time ?? kept[0]!.time + total
      args.push('-d', String(Math.max(1, Math.round(next - frame.time))), frame.file)
    }

    const webp = join(out, `${scene}-${theme}.webp`)
    await run('img2webp', [...args, '-o', webp], { maxBuffer: 1 << 26 })
    console.info(`${webp} (${kept.length} frames)`)
  })
}

try {
  for (const theme of THEMES) {
    const only = process.env.BANNERS?.split(',')
    for (const scene of Object.keys(CAPTURE_SIZES).filter(scene => !only || only.includes(scene)))
      await (STILLS.has(scene) ? still : animated)(scene, theme)
  }
}
finally {
  await server.close()
  rmSync(work, { force: true, recursive: true })
}
