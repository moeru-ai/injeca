import type { DecideFor, DecisionFor } from '../primitives/decision'

/** The context of an `onTimeout` handler. `hook` tells which hook timed out, and selects the methods of `decide`. */
export type TimeoutContext = {
  readonly [H in 'start' | 'stop']: {
    readonly hook: H
    /** The configured timeout in milliseconds. */
    readonly timeoutMs: number
    /** The attempt of the hook run that timed out. */
    readonly attempt: number
    /** The last decision of this hook for this instance. */
    readonly previous: DecisionFor<H> | undefined
    readonly decide: DecideFor<H>
  }
}['start' | 'stop']

/**
 * Decides what happens when a `start` or `stop` hook times out. It runs synchronously.
 *
 * A value that is not a decision, a promise, or a throw gives `fail` with `hook-timeout`.
 */
export type TimeoutHandler = (context: TimeoutContext) => unknown

/** The timeouts of the `start` and `stop` hooks in milliseconds. A missing value means no timeout. */
export interface HookTimeouts {
  /** The time for all `start` hooks of one attempt. */
  start?: number
  /** The time for all `stop` hooks and effect disposers of one instance. */
  stop?: number
}

/**
 * The retry and timeout options of a service or a container. injeca has no built-in values.
 *
 * A service value overrides a container value. A container without a value uses the value of its nearest ancestor that has one.
 */
export interface PolicyOptions {
  /**
   * Limits the attempts of a hook that returns `requeue`. A `maxAttempts` on the decision overrides it.
   * Without a limit, the requeue continues until the dependency or the container changes.
   */
  maxAttempts?: number
  /** The timeouts of the `start` and `stop` hooks. Each field overrides the same field of the container. */
  timeouts?: HookTimeouts
  /** Decides what happens when a hook times out. Without it, the result is `fail` with `hook-timeout`. */
  onTimeout?: TimeoutHandler
}
