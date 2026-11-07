import { describe, expect, it } from 'vitest'

import { accent, CHAPTER_HUES, contrast, GROUNDS, NEUTRALS } from './palette'

const STATE_HUES = [255, 300, 15, 160]

// Text on the page and text on a fill must both reach 4.5, the WCAG level for body text.
describe('palette', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`has text that reads on every ground in the ${theme} theme`, () => {
      for (const text of ['ink', 'ink-2', 'muted', 'faint'] as const) {
        for (const ground of GROUNDS[theme])
          expect(contrast(NEUTRALS[theme][text], ground), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5)
      }
    })

    for (const hue of [...STATE_HUES, ...CHAPTER_HUES]) {
      it(`reads in the ${theme} theme at hue ${hue}`, () => {
        const tokens = accent('x', hue, theme)
        for (const ground of GROUNDS[theme])
          expect(contrast(tokens.x!, ground)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(tokens['on-x']!, tokens['x-fill']!)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})
