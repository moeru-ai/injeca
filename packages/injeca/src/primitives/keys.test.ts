import { describe, expect, it } from 'vitest'

import { InvalidArgumentError } from '../diagnostics/errors'
import { readEdges } from '../graph/nodes'
import { defineKey, firstAvailable, isConditionalDependency, isExclusiveKey, isFallbackDependency, isOptionalDependency, normalizeName, optional, where } from './keys'

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

  it('marks an exclusive key, and rejects an exclusive option that is not a boolean', () => {
    const key = defineKey<string>('dev.airi.whiteboard', { exclusive: true })

    expect(key).toEqual({ key: 'dev.airi.whiteboard', exclusive: true })
    expect(isExclusiveKey(key)).toBe(true)
    expect(isExclusiveKey(defineKey('airi.llm'))).toBe(false)
    expect(isExclusiveKey('dev.airi.whiteboard')).toBe(false)
    // @ts-expect-error The exclusive option is a boolean.
    expect(() => defineKey('airi.llm', { exclusive: 'yes' })).toThrow(InvalidArgumentError)
  })
})

describe('where', () => {
  it('returns a frozen condition marker, and combines with optional() in both orders', () => {
    const key = defineKey<string>('airi.llm')
    const condition = (): boolean => true
    const marker = where(key, condition)

    expect(isConditionalDependency(marker)).toBe(true)
    expect(isConditionalDependency({ ...marker })).toBe(false)
    expect(Object.isFrozen(marker)).toBe(true)
    expect(optional(marker)).toMatchObject({ dependencies: ['airi.llm'], condition })
    expect(where(optional(key), condition)).toMatchObject({ dependencies: ['airi.llm'], condition })
    expect(readEdges('consumer', { llm: marker, tts: optional(where('airi.tts', condition)) })).toEqual([
      { name: 'llm', keyName: 'airi.llm', candidates: ['airi.llm'], optional: false, fallback: false, condition },
      { name: 'tts', keyName: 'airi.tts', candidates: ['airi.tts'], optional: true, fallback: false, condition },
    ])
  })

  it('rejects a condition that is not a function and a second condition', () => {
    const condition = (): boolean => true
    // @ts-expect-error The condition is a function.
    expect(() => where('airi.llm', 'v2')).toThrow(InvalidArgumentError)
    expect(() => where(where(optional('airi.llm'), condition), condition)).toThrow(InvalidArgumentError)
    expect(() => where(where(firstAvailable('a', 'b'), condition), condition)).toThrow(InvalidArgumentError)
    // @ts-expect-error A condition marker cannot get a second condition.
    expect(() => where(where('a', condition), condition)).toThrow(InvalidArgumentError)
  })

  it('accepts a firstAvailable marker in both orders, and combines with optional() in any order', () => {
    const all = (): boolean => true
    const remoteOnly = (): boolean => true
    const fallback = where(firstAvailable('remote', 'local'), all)

    expect(isFallbackDependency(fallback)).toBe(true)
    expect(Object.isFrozen(fallback)).toBe(true)
    expect(fallback).toMatchObject({ dependencies: ['remote', 'local'], condition: all })
    const inner = firstAvailable(where('remote', remoteOnly), 'local')
    expect(inner).toMatchObject({ dependencies: ['remote', 'local'], candidateConditions: { remote: remoteOnly } })

    expect(readEdges('consumer', {
      outer: fallback,
      inner,
      both: where(firstAvailable(where('remote', remoteOnly), 'local'), all),
      optionalOuter: optional(where(firstAvailable('remote', 'local'), all)),
      outerOptional: where(optional(firstAvailable('remote', 'local')), all),
      optionalInner: optional(firstAvailable(where('remote', remoteOnly), 'local')),
    })).toEqual([
      { name: 'outer', keyName: 'remote | local', candidates: ['remote', 'local'], optional: false, fallback: true, condition: all },
      { name: 'inner', keyName: 'remote | local', candidates: ['remote', 'local'], optional: false, fallback: true, candidateConditions: { remote: remoteOnly } },
      { name: 'both', keyName: 'remote | local', candidates: ['remote', 'local'], optional: false, fallback: true, condition: all, candidateConditions: { remote: remoteOnly } },
      { name: 'optionalOuter', keyName: 'remote | local', candidates: ['remote', 'local'], optional: true, fallback: true, condition: all },
      { name: 'outerOptional', keyName: 'remote | local', candidates: ['remote', 'local'], optional: true, fallback: true, condition: all },
      { name: 'optionalInner', keyName: 'remote | local', candidates: ['remote', 'local'], optional: true, fallback: true, candidateConditions: { remote: remoteOnly } },
    ])
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
