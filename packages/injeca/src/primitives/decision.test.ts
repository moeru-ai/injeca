import { describe, expect, it } from 'vitest'

import { InvalidArgumentError, InvalidDecisionError } from '../diagnostics/errors'
import { checkDecision, createHookContext } from '../testing/testing'

describe('decide in a hook context', () => {
  it('creates frozen decisions with the fields of the context', () => {
    const context = createHookContext('dependency-status-change', { unit: 'voice.speech', instanceId: 'i7', attempt: 3, now: () => 42 })
    const decision = context.decide.requeue({ after: 100, reason: 'warming up' })

    expect(decision).toEqual({ kind: 'requeue', after: 100, reason: 'warming up', unit: 'voice.speech', instanceId: 'i7', hook: 'dependency-status-change', attempt: 3, issuedAt: 42 })
    expect(Object.isFrozen(decision)).toBe(true)
    expect(checkDecision(context, decision)).toBe(decision)
    expect(context.attempt).toBe(3)
    expect(context.dependsOn).toEqual({})
    expect(context.changes).toEqual([])
  })

  it('gives undefined for undefined, so that the caller applies the default', () => {
    expect(checkDecision(createHookContext('start'), undefined)).toBeUndefined()
    expect(checkDecision(createHookContext('stop'), undefined)).toBeUndefined()
  })

  // Design test 11.
  it('gives undefined for a value that is not a decision, and rejects a decision from another run with invalid-decision', () => {
    const start = createHookContext('start')
    const other = createHookContext('start')

    expect(checkDecision(start, { kind: 'handled' })).toBeUndefined()
    expect(checkDecision(start, 'handled')).toBeUndefined()
    expect(checkDecision(start, 42)).toBeUndefined()
    expect(checkDecision(start, null)).toBeUndefined()
    expect(checkDecision(start, { ...start.decide.handled() })).toBeUndefined()
    expect(() => checkDecision(start, other.decide.handled())).toThrow(expect.objectContaining({ code: 'invalid-decision' }))
    // Another hook of the same unit is another run.
    expect(() => checkDecision(createHookContext('stop'), start.decide.handled())).toThrow(InvalidDecisionError)
  })

  it('rejects a kind that the hook does not accept', () => {
    const stop = createHookContext('stop')
    const start = createHookContext('start')
    const anyDecide = stop.decide as unknown as ReturnType<typeof createHookContext<'dependency-change'>>['decide']
    const anyStartDecide = start.decide as unknown as ReturnType<typeof createHookContext<'dependency-change'>>['decide']

    expect(() => checkDecision(start, anyStartDecide.rebuild())).toThrow(InvalidDecisionError)
    expect(() => checkDecision(stop, anyDecide.stop())).toThrow(InvalidDecisionError)
    expect(() => checkDecision(stop, anyDecide.requeue())).toThrow(InvalidDecisionError)
    expect(checkDecision(stop, stop.decide.fail('x'))?.kind).toBe('fail')
  })

  it('rejects a context that does not come from createHookContext, and an invalid attempt', () => {
    expect(() => checkDecision({}, undefined)).toThrow(InvalidArgumentError)
    expect(() => createHookContext('start', { attempt: 0 })).toThrow(InvalidArgumentError)
  })
})
