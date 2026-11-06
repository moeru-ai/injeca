import type { Plugin } from 'vite'

import { fileURLToPath } from 'node:url'

import VueI18n from '@intlify/unplugin-vue-i18n/vite'
import vue from '@vitejs/plugin-vue'
import Yaml from 'unplugin-yaml/vite'

import { icons as devicon } from '@iconify-json/devicon'
import { icons as mingcute } from '@iconify-json/mingcute'
import { codeToTokens } from '@pierre/highlights'
import { defineConfig } from 'vite'

import { cjkFont } from './scripts/cjk-font.ts'
import { CODE_THEMES } from './src/code-theme.ts'
import { SAMPLES } from './src/lab/samples.ts'
import { paletteCss } from './src/palette.ts'

const HIGHLIGHTED = 'virtual:highlighted-samples'
const ICONS = 'virtual:icons'

/** The icons that the page uses: MingCute by name, and Devicon as `devicon:<name>`. The build takes only these out of the sets. */
const ICON_NAMES = [
  'play-fill',
  'down-line',
  'key-2-fill',
  'refresh-3-fill',
  'heartbeat-fill',
  'box-3-fill',
  'layers-fill',
  'search-2-fill',
  'flask-fill',
  'copy-2-line',
  'check-line',
  'menu-line',
  'close-line',
  'github-line',
  'sun-line',
  'moon-line',
  'heart-fill',
  'translate-2-line',
  'devicon:pnpm',
  'devicon:npm',
  'devicon:bun',
  'devicon:yarn',
] as const

/**
 * Highlights the code of each variant at build time with @pierre/highlights, so the page ships colored tokens and no
 * WebAssembly. The module exports, for the dark and the light theme, the lines of each sample, each a list of tokens.
 */
function highlightedSamples(): Plugin {
  return {
    load(id) {
      if (id !== `\0${HIGHLIGHTED}`)
        return
      const highlight = (theme: keyof typeof CODE_THEMES) => Object.fromEntries(Object.entries(SAMPLES).map(([key, code]) => [
        key,
        codeToTokens(code, { lang: 'typescript', theme: CODE_THEMES[theme] }).tokens.map(line =>
          line.map(token => ({ color: token.color, content: token.content, fontStyle: token.fontStyle })),
        ),
      ]))
      return `export default ${JSON.stringify({ dark: highlight('dark'), light: highlight('light') })}`
    },
    name: 'highlighted-samples',
    resolveId(id) {
      return id === HIGHLIGHTED ? `\0${HIGHLIGHTED}` : undefined
    },
  }
}

/** Puts the SVG bodies of ICON_NAMES and their view boxes into a module, so the page ships those icons and not the whole sets. */
function icons(): Plugin {
  return {
    load(id) {
      if (id !== `\0${ICONS}`)
        return
      const bodies = Object.fromEntries(ICON_NAMES.map((name) => {
        const [set, icon] = name.startsWith('devicon:') ? [devicon, name.slice('devicon:'.length)] : [mingcute, name]
        const found = set.icons[icon]
        if (!found)
          throw new Error(`${set.prefix} has no icon ${icon}.`)
        return [name, { body: found.body, size: found.width ?? set.width ?? 24 }]
      }))
      return `export default ${JSON.stringify(bodies)}`
    },
    name: 'icons',
    resolveId(id) {
      return id === ICONS ? `\0${ICONS}` : undefined
    },
  }
}

/** Puts the colors of src/palette.ts into the page head, as CSS custom properties for both themes. */
function palette(): Plugin {
  return {
    name: 'palette',
    transformIndexHtml: () => [{ children: paletteCss(), injectTo: 'head', tag: 'style' }],
  }
}

export default defineConfig({
  // Relative asset paths, so the build works from any directory, for example GitHub Pages under /injeca/
  base: './',
  plugins: [
    vue(),
    // The locales are YAML, as in moeru-ai/airi. vue-i18n compiles their messages in the page.
    Yaml(),
    // https://github.com/intlify/bundle-tools/tree/main/packages/unplugin-vue-i18n
    // Its types crash the checker with this Vite, so it takes the type of Vite.
    VueI18n({ compositionOnly: true, fullInstall: true, runtimeOnly: false }) as Plugin,
    palette(),
    highlightedSamples(),
    icons(),
    cjkFont(),
  ],
  resolve: {
    // The lab runs the source of injeca, so the page needs no build of the package, and it always shows the current behavior.
    alias: {
      'injeca/testing': fileURLToPath(new URL('../../packages/injeca/src/testing/testing.ts', import.meta.url)),
      'injeca': fileURLToPath(new URL('../../packages/injeca/src/index.ts', import.meta.url)),
    },
  },
})
