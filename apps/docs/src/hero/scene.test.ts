import { describe, expect, it } from 'vitest'

import { BATCHES, byId, LEVELS, UNITS } from './scene'

describe('hero scene', () => {
  it('cuts the cube into the pieces that app needs, with no hole and no overlap', () => {
    const used = UNITS.filter(unit => !unit.unused)
    const cells = used.flatMap(unit => unit.cells.map(cell => cell.join(',')))
    expect(new Set(cells).size).toBe(27)
    expect(cells).toHaveLength(27)
    expect(cells.every(cell => cell.split(',').every(n => Number(n) >= 0 && Number(n) <= 2))).toBe(true)
  })

  it('has a piece for each unit that the entry needs, and only those', () => {
    expect(new Set(LEVELS.flat())).toEqual(new Set(UNITS.filter(unit => !unit.unused).map(unit => unit.id)))
  })

  it('builds each unit after every unit that it needs', () => {
    const batchOf = new Map(BATCHES.flatMap((batch, i) => batch.map(id => [id, i] as const)))
    for (const [id, batch] of batchOf) {
      for (const need of byId(id).needs)
        expect(batchOf.get(need)).toBeLessThan(batch)
    }
  })
})
