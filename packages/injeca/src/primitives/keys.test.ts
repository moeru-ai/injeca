import { describe, expect, it } from 'vitest'

import { InvalidArgumentError } from '../diagnostics/errors'
import { readEdges } from '../graph/nodes'
import { defineKey, firstAvailable, isFallbackDependency, isOptionalDependency, normalizeName, optional } from './keys'

describe('defineKey', () => {
  it('returns a frozen key that normalizes to its name', () => {
    const key = defineKey<number>('airi.counter')

    expect(key).toEqual({ key: 'airi.counter' })
    expect(Object.isFrozen(key)).toBe(true)
    expect(normalizeName(key)).toBe('airi.counter')
  })

  it('rejects an empty name or a name with outer whitespace', () => {
    expect(() => defineKey('')).toThrow(InvalidArgumentError)
    expect(() => defineKey(' airi.llm')).toThrow(InvalidArgumentError)
    expect(() => defineKey('airi.llm\n')).toThrow(InvalidArgumentError)
  })
})

describe('optional', () => {
  it('returns a frozen marker that is not a key', () => {
    const key = defineKey<number>('airi.counter')
    const marker = optional(key)

    expect(isOptionalDependency(marker)).toBe(true)
    expect(isOptionalDependency({ ...marker })).toBe(false)
    expect(marker.dependencies).toEqual(['airi.counter'])
    expect('key' in marker).toBe(false)
    expect(Object.isFrozen(marker)).toBe(true)
  })
})

describe('firstAvailable', () => {
  it('returns a frozen marker with the keys in order, and optional() accepts it', () => {
    const remote = defineKey<string>('airi.llm.remote')
    const marker = firstAvailable(remote, 'airi.llm.local')

    expect(isFallbackDependency(marker)).toBe(true)
    expect(isFallbackDependency({ ...marker })).toBe(false)
    expect(marker.dependencies).toEqual(['airi.llm.remote', 'airi.llm.local'])
    expect(Object.isFrozen(marker)).toBe(true)
    expect(optional(marker).dependencies).toEqual(['airi.llm.remote', 'airi.llm.local'])
  })

  it('rejects an empty list and a repeated key', () => {
    expect(() => firstAvailable()).toThrow(InvalidArgumentError)
    expect(() => firstAvailable('a', 'a')).toThrow(InvalidArgumentError)
  })

  it('reads a required fallback edge and an optional fallback edge', () => {
    const edges = readEdges('consumer', { llm: firstAvailable('a', 'b'), tts: optional(firstAvailable('c', 'd')) })

    expect(edges).toEqual([
      { name: 'llm', keyName: 'a | b', candidates: ['a', 'b'], optional: false, fallback: true },
      { name: 'tts', keyName: 'c | d', candidates: ['c', 'd'], optional: true, fallback: true },
    ])
  })
})
