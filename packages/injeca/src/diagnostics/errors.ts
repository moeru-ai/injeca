import type { UnitExplanation } from '../types/unit'

export type InjecaErrorCode
  = | 'build-after-dispose'
    | 'duplicate-unit'
    | 'hook-outside-build'
    | 'hook-timeout'
    | 'invalid-argument'
    | 'invalid-decision'
    | 'unit-failed'
    | 'replace-while-stopping'
    | 'stale-registration'
    | 'start-timeout'
    | 'transaction-incomplete'
    | 'wait-timeout'

export interface InjecaErrorOptions {
  cause?: unknown
}

/**
 * The base class of all injeca errors. Use `code` to identify an error. The message text is not stable.
 */
export class InjecaError extends Error {
  readonly code: InjecaErrorCode

  constructor(code: InjecaErrorCode, message: string, options?: InjecaErrorOptions) {
    super(message, options)
    this.name = 'InjecaError'
    this.code = code
  }
}

/** A started container already has a current registration for the key. */
export class DuplicateUnitError extends InjecaError {
  declare readonly code: 'duplicate-unit'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('duplicate-unit', message, options)
    this.name = 'DuplicateUnitError'
  }
}

/** A registration is no longer the current registration of its unit. */
export class StaleRegistrationError extends InjecaError {
  declare readonly code: 'stale-registration'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('stale-registration', message, options)
    this.name = 'StaleRegistrationError'
  }
}

/** A hook returned a decision from another run, or a kind that the hook does not accept. */
export class InvalidDecisionError extends InjecaError {
  declare readonly code: 'invalid-decision'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('invalid-decision', message, options)
    this.name = 'InvalidDecisionError'
  }
}

/** A caller used a container or an instance after its disposal started. */
export class BuildAfterDisposeError extends InjecaError {
  declare readonly code: 'build-after-dispose'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('build-after-dispose', message, options)
    this.name = 'BuildAfterDisposeError'
  }
}

/** `on` was called after `build` settled. */
export class HookOutsideBuildError extends InjecaError {
  declare readonly code: 'hook-outside-build'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('hook-outside-build', message, options)
    this.name = 'HookOutsideBuildError'
  }
}

/** A transaction commit found a declared unit without `provide`. */
export class TransactionIncompleteError extends InjecaError {
  declare readonly code: 'transaction-incomplete'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('transaction-incomplete', message, options)
    this.name = 'TransactionIncompleteError'
  }
}

/** A `start` or `stop` hook did not settle before its configured timeout. */
export class HookTimeoutError extends InjecaError {
  declare readonly code: 'hook-timeout'
  readonly hook: 'start' | 'stop'
  readonly timeoutMs: number

  constructor(message: string, hook: 'start' | 'stop', timeoutMs: number, options?: InjecaErrorOptions) {
    super('hook-timeout', message, options)
    this.name = 'HookTimeoutError'
    this.hook = hook
    this.timeoutMs = timeoutMs
  }
}

/** `replace` was called on a unit in `stopping`. */
export class ReplaceWhileStoppingError extends InjecaError {
  declare readonly code: 'replace-while-stopping'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('replace-while-stopping', message, options)
    this.name = 'ReplaceWhileStoppingError'
  }
}

/** `start()` did not reach `running` for every unit before its configured timeout. */
export class StartTimeoutError extends InjecaError {
  declare readonly code: 'start-timeout'
  /** One entry for each unit or invocation that is not `running`. */
  readonly explanations: readonly UnitExplanation[]

  constructor(message: string, explanations: readonly UnitExplanation[], options?: InjecaErrorOptions) {
    super('start-timeout', message, options)
    this.name = 'StartTimeoutError'
    this.explanations = explanations
  }
}

/** `waitFor()` found the unit in `failed`, or waiting for a required provider in `failed`. `cause` is the failure. */
export class UnitFailedError extends InjecaError {
  declare readonly code: 'unit-failed'
  /** The key name that the caller waited for. */
  readonly key: string

  constructor(message: string, key: string, options?: InjecaErrorOptions) {
    super('unit-failed', message, options)
    this.name = 'UnitFailedError'
    this.key = key
  }
}

/** `waitFor()`, `resolve()`, or `replace()` did not reach its state before the timeout signal aborted. */
export class WaitTimeoutError extends InjecaError {
  declare readonly code: 'wait-timeout'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('wait-timeout', message, options)
    this.name = 'WaitTimeoutError'
  }
}

/** A caller passed a value with the wrong shape, or reading a caller-owned property failed. */
export class InvalidArgumentError extends InjecaError {
  declare readonly code: 'invalid-argument'

  constructor(message: string, options?: InjecaErrorOptions) {
    super('invalid-argument', message, options)
    this.name = 'InvalidArgumentError'
  }
}
