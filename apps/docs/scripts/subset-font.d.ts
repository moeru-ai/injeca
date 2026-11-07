declare module 'subset-font' {
  import type { Buffer } from 'node:buffer'

  /** Cuts a font down to the glyphs of `text`. */
  export default function subsetFont(font: Buffer, text: string, options?: { targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype' }): Promise<Buffer>
}
