import type { Frame } from './lab'
import type { Scenario, Variant } from './scenarios'

import { shallowRef } from 'vue'

import { createLab } from './lab'
import { runVariant, SCENARIOS } from './scenarios'

/** The frames of each variant, by `<scenario>/<variant>`. The page runs every variant once, when it loads. */
export const frames = shallowRef<ReadonlyMap<string, readonly Frame[]>>(new Map())

export const framesOf = (scenario: Scenario, variant: Variant): readonly Frame[] => frames.value.get(`${scenario.id}/${variant.id}`) ?? []

/** Resolves when all variants ran. A capture waits for it before the screenshot. */
export const ready: Promise<void> = (async () => {
  const map = new Map<string, readonly Frame[]>()
  for (const scenario of SCENARIOS) {
    for (const variant of scenario.variants)
      map.set(`${scenario.id}/${variant.id}`, await runVariant(scenario, variant, createLab))
  }
  frames.value = map
})()
