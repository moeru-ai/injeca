import type { DecisionKind, ServiceHook } from '../primitives/decision'
import type { OwnerRecord, ServicePhase, ServiceStatus, StatusCause } from './service'

export interface ObserveRecordBase {
  /** The key name of the service, or the name of the invocation. */
  readonly key: string
  /** The owner record of the container of the service. */
  readonly owner: OwnerRecord
  readonly instanceId: string | undefined
  readonly reason?: string
}

/** A service moved to another phase. A replayed record has no `from`. */
export interface PhaseObserveRecord extends ObserveRecordBase {
  readonly type: 'phase'
  readonly from: ServicePhase | undefined
  readonly to: ServicePhase
  /** The decision that caused the move, when a decision caused it. */
  readonly decision?: DecisionKind
}

/** The effective status of a running instance changed. A replayed record, or the first status of an instance, has no `from`. */
export interface StatusObserveRecord extends ObserveRecordBase {
  readonly type: 'status'
  readonly from: ServiceStatus | undefined
  readonly to: ServiceStatus
  readonly cause?: StatusCause
}

/** A hook returned a decision. `ignored` is `true` when injeca did not apply it. */
export interface DecisionObserveRecord extends ObserveRecordBase {
  readonly type: 'decision'
  readonly hook: ServiceHook
  readonly decision: DecisionKind
  readonly attempt: number
  readonly ignored: boolean
}

/** A call that had no effect, for example `setStatus` after the instance was disposed. */
export interface IgnoredObserveRecord extends ObserveRecordBase {
  readonly type: 'ignored'
  readonly call: 'setStatus'
}

/** A `start` or `stop` hook did not settle before its configured timeout. The `onTimeout` decision follows as a `decision` record. */
export interface TimeoutObserveRecord extends ObserveRecordBase {
  readonly type: 'timeout'
  readonly hook: 'start' | 'stop'
  readonly timeoutMs: number
  readonly attempt: number
}

/** A second `provide` of the same key before `start()` replaced the current registration. No hook runs for it. */
export interface RegistrationReplacedObserveRecord extends ObserveRecordBase {
  readonly type: 'registration-replaced'
  readonly reason: string
}

/** A `watch` or `observe` callback threw. The error did not stop a transition or the other callbacks. */
export interface ErrorObserveRecord extends ObserveRecordBase {
  readonly type: 'error'
  readonly error: unknown
}

/**
 * The `signal` of `stop()`, `dispose()`, or `withdraw()` aborted before this service stopped. The call stopped waiting. The cleanups of the service keep running.
 * `phase` is the phase at the abort. `abortReason` is the reason of the signal.
 */
export interface WaitAbortedObserveRecord extends ObserveRecordBase {
  readonly type: 'wait-aborted'
  readonly call: 'stop' | 'dispose' | 'withdraw'
  readonly phase: ServicePhase
  readonly reason: string
  readonly abortReason: unknown
}

/**
 * A cleanup called `stop()` or `dispose()` of its own container, or of an ancestor, or `withdraw()` of a registration that waits for that cleanup.
 * The wait includes that cleanup, so injeca resolved the call at once. The action continues.
 * `key` is the service of the cleanup, or `''` for a container effect.
 */
export interface ReentrantCallObserveRecord extends ObserveRecordBase {
  readonly type: 'reentrant-call'
  readonly call: 'stop' | 'dispose' | 'withdraw'
  readonly reason: string
}

/** One record of the observe stream. */
export type ObserveRecord
  = | PhaseObserveRecord
    | StatusObserveRecord
    | DecisionObserveRecord
    | IgnoredObserveRecord
    | TimeoutObserveRecord
    | RegistrationReplacedObserveRecord
    | ErrorObserveRecord
    | WaitAbortedObserveRecord
    | ReentrantCallObserveRecord
