import type { Decision, HookRun, UnitHook } from '../primitives/decision'
import type { DependencyChange, HookContextFor, HookDependencies } from '../types'

import { InvalidArgumentError } from '../diagnostics/errors'
import { createDecide, validateDecision } from '../primitives/decision'

export { drained } from './drained'
export { manualClock } from './manual-clock'
export type { ManualClock } from './manual-clock'

export interface HookContextOptions<D = undefined> {
  /** The unit name that the decisions carry. It defaults to `'test'`. */
  unit?: string
  /** The instance id that the decisions carry. It defaults to `'test-instance'`. */
  instanceId?: string
  /** It defaults to `1`. */
  attempt?: number
  previous?: Decision
  /** It defaults to a signal that does not abort. */
  signal?: AbortSignal
  /** The snapshot of a dependency hook. It defaults to an empty record. */
  dependsOn?: HookDependencies<D>
  /** The changes of a dependency hook. It defaults to an empty list. */
  changes?: readonly DependencyChange[]
  /** The clock for `issuedAt`. It defaults to `Date.now`. */
  now?: () => number
}

const runs = new WeakMap<object, HookRun>()

/**
 * Creates a hook context for a unit test of a hook handler, or of a helper that gets `decide`.
 *
 * Its decisions are bound to this context, as in a real run. Use `checkDecision` to check a result as injeca does.
 */
export function createHookContext<H extends UnitHook, D = undefined>(hook: H, options: HookContextOptions<D> = {}): HookContextFor<H, D> {
  const attempt = options.attempt ?? 1
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new InvalidArgumentError(`The attempt of a hook context must be an integer of 1 or more. Got ${String(attempt)}.`)

  const run: HookRun = {
    unit: options.unit ?? 'test',
    instanceId: options.instanceId ?? 'test-instance',
    hook,
    attempt,
    now: options.now ?? (() => Date.now()),
  }
  const dependencyHook = hook === 'dependency-change' || hook === 'dependency-status-change'
  const context = Object.freeze({
    decide: createDecide(run),
    attempt,
    previous: options.previous,
    signal: options.signal ?? new AbortController().signal,
    ...(dependencyHook ? { dependsOn: Object.freeze({ ...options.dependsOn }), changes: Object.freeze([...(options.changes ?? [])]) } : {}),
  })
  runs.set(context, run)

  return context as unknown as HookContextFor<H, D>
}

/**
 * Checks the value that a handler returned for `context`, as injeca does. `undefined` gives `undefined`: the default of the hook.
 *
 * @throws {InvalidDecisionError} for a decision from another context, or a kind that the hook does not accept. A value that is not a decision gives `undefined`.
 */
export function checkDecision(context: object, value: unknown): Decision | undefined {
  const run = runs.get(context)
  if (!run)
    throw new InvalidArgumentError('The context does not come from createHookContext.')

  return validateDecision(run, value)
}
