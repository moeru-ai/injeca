import type { Shade } from '@proj-airi/chromatic'

import { chromaticColorFrom } from '@proj-airi/chromatic'

// The colors of the page come from @proj-airi/chromatic, the palette of Project AIRI: one hue for each accent, and a
// shade for each use. The neutrals are plain greys with no hue. The build turns this file into CSS custom properties.

/** The hues of the states. Blue is a new instance at work, violet is degraded, red is a failure, green works. */
const STATES = { new: 255, degraded: 300, bad: 15, good: 160 } as const

/** One hue for each chapter, in order. The page skips the yellows, which read poorly on paper. */
export const CHAPTER_HUES = [255, 210, 165, 135, 285, 330, 15, 45, 270, 195] as const

const hex = (hue: number, shade: Shade) => chromaticColorFrom(hue, { shade }).toHex()
const alpha = (hue: number, shade: Shade, value: number) => chromaticColorFrom(hue, { shade }).withAlpha(value).toCSS()

/**
 * The neutrals, by role. Every surface has one job, so a thing on it always stands apart:
 *
 * - `paper`: the page.
 * - `surface`: a card or a panel on the page.
 * - `control`: a pill, a chip, a field, or a node, on the page or on a surface. `control-2` is its hover, and
 *   `control-3` a strong fill, like a track. `knob` is the thumb that slides on a control.
 * - `ink` down to `faint`: text. Each reads at 4.5 or more on every ground; palette.test.ts checks it.
 */
export const NEUTRALS = {
  light: { 'paper': '#f6f6f6', 'surface': '#ffffff', 'control': '#ececec', 'control-2': '#e2e2e2', 'control-3': '#d4d4d4', 'knob': '#ffffff', 'ink': '#171717', 'ink-2': '#3d3d3d', 'muted': '#5a5a5a', 'faint': '#636363' },
  dark: { 'paper': '#0d0d0d', 'surface': '#171717', 'control': '#232323', 'control-2': '#2d2d2d', 'control-3': '#3b3b3b', 'knob': '#3b3b3b', 'ink': '#ededed', 'ink-2': '#c8c8c8', 'muted': '#9e9e9e', 'faint': '#949494' },
} as const

/** The grounds that text sits on: the page, a surface, and a control with its hover. */
export const GROUNDS = {
  light: [NEUTRALS.light.paper, NEUTRALS.light.surface, NEUTRALS.light.control, NEUTRALS.light['control-2']],
  dark: [NEUTRALS.dark.paper, NEUTRALS.dark.surface, NEUTRALS.dark.control, NEUTRALS.dark['control-2']],
} as const

/** The relative luminance of a color, after WCAG 2. */
function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(color.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** The contrast ratio of two colors, after WCAG 2: from 1 to 21. Body text needs 4.5. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** The first shade in `shades` whose color has a contrast of 4.5 or more with each of `against`. */
function readable(hue: number, shades: readonly Shade[], against: readonly string[]): Shade {
  return shades.find(shade => against.every(ground => contrast(hex(hue, shade), ground) >= 4.5)) ?? shades.at(-1)!
}

/**
 * The tokens of one accent:
 *
 * - `<name>`: text and lines on the page.
 * - `<name>-fill`: a solid fill, with `on-<name>` on it.
 * - `<name>-soft` and `<name>-softer`: grounds.
 */
export function accent(name: string, hue: number, theme: 'light' | 'dark'): Record<string, string> {
  // Each shade is the lightest one that reads: text on both grounds, and the text of a fill on that fill.
  if (theme === 'light') {
    const fill = readable(hue, [500, 600, 700, 800], ['#ffffff'])
    return {
      [name]: hex(hue, readable(hue, [600, 700, 800], GROUNDS.light)),
      [`${name}-fill`]: hex(hue, fill),
      [`${name}-soft`]: hex(hue, 100),
      [`${name}-softer`]: hex(hue, 50),
      [`on-${name}`]: '#ffffff',
    }
  }
  const on = hex(hue, 950)
  return {
    [name]: hex(hue, readable(hue, [300, 200, 100], GROUNDS.dark)),
    [`${name}-fill`]: hex(hue, readable(hue, [400, 300, 200], [on])),
    [`${name}-soft`]: alpha(hue, 800, 0.45),
    [`${name}-softer`]: alpha(hue, 900, 0.35),
    [`on-${name}`]: on,
  }
}

function block(selector: string, values: Record<string, string>): string {
  return `${selector} {\n${Object.entries(values).map(([k, v]) => `  --${k}: ${v};`).join('\n')}\n}`
}

export function paletteCss(): string {
  const states = (theme: 'light' | 'dark') => Object.assign({}, ...Object.entries(STATES).map(([name, hue]) => accent(name, hue, theme)))
  return [
    block(':root', { ...NEUTRALS.light, ...states('light') }),
    block(':root[data-theme=\'dark\']', { ...NEUTRALS.dark, ...states('dark') }),
    // A chapter sets `--accent` and its family through its class, `hue-<index>`.
    ...CHAPTER_HUES.flatMap((hue, i) => [
      block(`.hue-${i}`, accent('accent', hue, 'light')),
      block(`:root[data-theme='dark'] .hue-${i}`, accent('accent', hue, 'dark')),
    ]),
  ].join('\n\n')
}
