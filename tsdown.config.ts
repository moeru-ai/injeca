import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    global: 'src/global.ts',
  },
  dts: true,
  sourcemap: true,
  unused: true,
})
