// Renders the README banners, in the dark and the light theme, as WebP in docs/assets/banners.
// It builds the page and serves it with vite preview. Each banner is a screenshot of ?capture=<scene> from headless
// Chrome at 2x, converted with cwebp. The lab runs injeca in the page, so each figure shows the behavior of the source.
//
//   pnpm -F @injeca/docs banners
//
// CHROME points to another Chrome binary. cwebp must be on PATH (brew install webp).

import process from 'node:process'

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

async function still(scene: string, theme: string): Promise<void> {
  const { height, width } = CAPTURE_SIZES[scene]!
  const png = join(work, `${scene}-${theme}.png`)
  // Headless Chrome on macOS can exit with an error in its teardown, after it wrote the screenshot. Only a missing file fails.
  await run(chrome, [
    '--headless=new',
    // WebGL in headless Chrome, for the hero scene.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    // Transparent around the rounded corners of the banner.
    '--default-background-color=00000000',
    `--window-size=${width},${height}`,
    // Gives the lab time to run every variant, and the fonts time to arrive, before the screenshot.
    '--virtual-time-budget=6000',
    `--user-data-dir=${join(work, 'profile')}`,
    `--screenshot=${png}`,
    `${origin}/?capture=${scene}&theme=${theme}`,
  ], { timeout: 60_000 }).catch((error: unknown) => {
    if (!existsSync(png))
      throw error
  })
  const webp = join(out, `${scene}-${theme}.webp`)
  await run('cwebp', ['-quiet', '-q', '92', png, '-o', webp])
  console.info(webp)
}

try {
  for (const theme of THEMES) {
    for (const scene of Object.keys(CAPTURE_SIZES))
      await still(scene, theme)
  }
}
finally {
  await server.close()
  rmSync(work, { force: true, recursive: true })
}
