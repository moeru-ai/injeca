import { fileURLToPath } from 'node:url'

import Yaml from 'unplugin-yaml/vite'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The locales of apps/docs are YAML.
  plugins: [Yaml()],
  resolve: {
    // The lab of apps/docs runs the source of injeca, so its tests need no build.
    alias: {
      'injeca/testing': fileURLToPath(new URL('./packages/injeca/src/testing/testing.ts', import.meta.url)),
      'injeca': fileURLToPath(new URL('./packages/injeca/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/docs/src/**/*.test.ts'],
  },
})
