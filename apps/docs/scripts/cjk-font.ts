import type { Plugin } from 'vite'

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import subsetFont from 'subset-font'

const ID = 'virtual:cjk-font'
const FAMILY = 'LXGW 975 Yuan SC'
const WEIGHTS = [400, 700] as const

const locales = fileURLToPath(new URL('../src/locales', import.meta.url))
const cache = fileURLToPath(new URL('../node_modules/.cache/cjk-font', import.meta.url))
const font = (weight: number) => createRequire(import.meta.url).resolve(`@proj-airi/font-lxgw-975yuan/files/LXGW975YuanSC-${weight}W.ttf`)

/** Every file of the locales that has CJK text: all but English. */
function localeFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory())
        walk(path)
      else if (entry.name.endsWith('.yaml'))
        files.push(path)
    }
  }
  for (const entry of readdirSync(locales, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'en')
      walk(join(locales, entry.name))
  }
  return files
}

/**
 * LXGW 975 Yuan for the Chinese text of the page, cut down to the characters that the locales use. Each weight of the
 * full font is about 15 MB; the cut is some hundred KB. The Latin text keeps Varela Round and DM Sans, which come
 * first in the font stacks, so only CJK characters reach this font.
 *
 * The module adds the faces with the FontFace API. The browser loads a face only when the page shows a character of it.
 */
export function cjkFont(): Plugin {
  return {
    name: 'cjk-font',
    resolveId: id => (id === ID ? `\0${ID}` : undefined),
    async load(id) {
      if (id !== `\0${ID}`)
        return
      const files = localeFiles()
      for (const file of files)
        this.addWatchFile(file)
      // The characters outside of Latin and its punctuation: CJK, kana, and full-width forms.
      const text = [...new Set([...files.map(file => readFileSync(file, 'utf8')).join('')].filter(char => char.codePointAt(0)! >= 0x2E80))].sort().join('')
      mkdirSync(cache, { recursive: true })
      const imports: string[] = []
      for (const weight of WEIGHTS) {
        const hash = createHash('sha256').update(`${weight}:${text}`).digest('hex').slice(0, 10)
        const path = join(cache, `975-${weight}-${hash}.woff2`)
        try {
          readFileSync(path)
        }
        catch {
          writeFileSync(path, await subsetFont(readFileSync(font(weight)), text, { targetFormat: 'woff2' }))
        }
        imports.push(`import w${weight} from ${JSON.stringify(`${path}?url`)}`)
      }
      return `${imports.join('\n')}
for (const [url, weight] of [${WEIGHTS.map(weight => `[w${weight}, '${weight}']`).join(', ')}])
  document.fonts.add(new FontFace(${JSON.stringify(FAMILY)}, \`url(\${url}) format('woff2')\`, { weight, display: 'swap' }))
`
    },
  }
}
