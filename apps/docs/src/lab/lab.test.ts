import type { Frame } from './lab'

import { describe, expect, it } from 'vitest'

import { COMPARED } from '../capture'
import { createLab } from './lab'
import { runVariant, SCENARIOS } from './scenarios'

/** One frame as text: the caption, each node with its instances, each edge that is not idle, and the observe records after the first frame. */
function render(frame: Frame, index: number): string {
  const nodes = Object.entries(frame.nodes).map(([node, views]) => {
    const instances = views.map(view => [view.version === undefined ? '-' : `v${view.version}`, view.phase, view.status].filter(Boolean).join(' '))
    return `  ${node}: ${instances.join(' | ')}`
  })
  const edges = Object.entries(frame.edges).filter(([, state]) => state !== 'idle').map(([edge, state]) => `  ${edge}: ${state}`)
  const calls = frame.calls.map(call => `  call ${call.label}: ${call.state}${call.detail ? ` ${call.detail}` : ''}`)
  const log = frame.log.map(line => `  > ${line.text}`)
  return [`#${index} t=${frame.time} ${frame.caption}`, ...nodes, ...edges, ...calls, ...(index === 0 ? [] : log)].join('\n')
}

it('has a comparison figure for each chapter with more than one variant', () => {
  expect(SCENARIOS.filter(scenario => scenario.variants.length > 1).map(scenario => scenario.id)).toEqual([...COMPARED])
})

// The figures of the README and of the page come from these frames. A change of behavior shows up here first.
describe('scenarios', () => {
  for (const scenario of SCENARIOS) {
    for (const variant of scenario.variants) {
      it(`${scenario.id}: ${variant.id}`, async () => {
        const frames = await runVariant(scenario, variant, createLab)
        expect(variant.key).toBeLessThan(frames.length)
        await expect(`${frames.map(render).join('\n\n')}\n`).toMatchFileSnapshot(`./__snapshots__/${scenario.id}-${variant.id}.txt`)
      })
    }
  }
})
