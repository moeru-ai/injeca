import { describe, expect, it } from 'vitest'

import { CHEAT } from '../cheat'
import { FEATURES } from '../features'
import { UNITS, STEPS } from '../hero/scene'
import { createLab } from '../lab/lab'
import { runVariant, SCENARIOS } from '../lab/scenarios'
import { CONTENT, MESSAGES } from './index'

/** The paths of every string in a tree, as `a.b.0.c`. */
function paths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'string')
    return [prefix]
  if (node === null || typeof node !== 'object')
    return []
  return Object.entries(node).flatMap(([key, value]) => paths(value, prefix ? `${prefix}.${key}` : key))
}

/** The English that a locale may translate by `text()`: the same shape as content.yaml. */
async function englishContent(): Promise<unknown> {
  const chapters: Record<string, unknown> = {}
  for (const scenario of SCENARIOS) {
    const variants: Record<string, unknown> = {}
    for (const variant of scenario.variants) {
      const frames = await runVariant(scenario, variant, createLab)
      variants[variant.id] = {
        outcome: variant.outcome,
        summary: variant.summary,
        steps: frames.map(frame => ({ caption: frame.caption, ...(frame.note ? { note: frame.note } : {}) })),
      }
    }
    chapters[scenario.id] = {
      nav: scenario.nav,
      title: scenario.title,
      intro: scenario.intro,
      ...(scenario.question ? { question: scenario.question } : {}),
      ...(scenario.boxes ? { boxes: scenario.boxes.map(box => box.label) } : {}),
      variants,
    }
  }
  return {
    chapters,
    features: FEATURES.map(feature => ({ title: feature.title, text: feature.text })),
    cheat: { groups: CHEAT.map(group => group.title), cards: Object.fromEntries(CHEAT.flatMap(group => group.cards.map(card => [card.id, card.text]))) },
    hero: { steps: STEPS.map(step => ({ title: step.title, text: step.text })), roles: Object.fromEntries(UNITS.map(unit => [unit.id, unit.role])) },
  }
}

describe('locales', () => {
  it('has no message that English lacks', () => {
    const english = new Set(paths(MESSAGES.en))
    for (const [locale, messages] of Object.entries(MESSAGES))
      expect(paths(messages).filter(path => !english.has(path)), locale).toEqual([])
  })

  it('translates only text that the page shows, so a moved step or a renamed variant shows up here', async () => {
    const english = new Set(paths(await englishContent()))
    for (const [locale, content] of Object.entries(CONTENT))
      expect(paths(content).filter(path => !english.has(path)), locale).toEqual([])
  })

  it('keeps the code of the English in each translation', async () => {
    const english = await englishContent()
    const at = (node: unknown, path: string) => path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], node)
    const code = (value: unknown) => String(value).match(/`[^`]+`/g) ?? []
    for (const [locale, content] of Object.entries(CONTENT)) {
      for (const path of paths(content))
        expect(code(at(content, path)), `${locale}: ${path}`).toEqual(code(at(english, path)))
    }
  })
})
