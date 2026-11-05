import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    global: 'src/global.ts',
    testing: 'src/testing/testing.ts',
  },
  dts: true,
  sourcemap: true,
  unused: true,
  failOnWarn: 'ci-only',
})
