import type { Logger, LoggerOptions } from '../diagnostics/logger'
import type { Clock } from '../helpers/clock'
import type { KeyReference } from './keys'
import type { PolicyOptions } from './policy'
import type { OwnerRecord } from './service'

/**
 * An async context that the caller injects, for example `AsyncLocalStorage` of `node:async_hooks`. injeca imports no runtime module.
 *
 * `run` runs `fn` with `store` as the current store, also across `await`. `get` returns the current store, or `undefined`.
 */
export interface AsyncContext {
  readonly run: <T>(store: unknown, fn: () => T) => T
  readonly get: () => unknown
}

export interface Container {
  logger: Logger
  readonly owner: OwnerRecord
  readonly parent: Container | undefined
}

/** The options of `createContainer`. `maxAttempts`, `timeouts`, and `onTimeout` apply to each service of the container and of its descendants that does not set its own value. */
export interface ContainerOptions extends LoggerOptions, PolicyOptions {
  /** Makes a child container. It resolves keys from its own registrations and from those of its ancestors. */
  parent?: Container
  /** A serializable owner record. It defaults to an empty record. */
  owner?: OwnerRecord
  /** The time source. Only a root container reads it. A child container uses the clock of its root. */
  clock?: Clock
  /**
   * The random source for the backoff jitter. It returns a number from 0 up to, but not including, 1. It defaults to `Math.random`.
   * Only a root container reads it. A child container uses the random source of its root.
   */
  random?: () => number
  /**
   * An async context, so that a cleanup that awaits the disposal of its own container or of an ancestor rejects with `reentrant-dispose` at once.
   * Without it, injeca detects only a call from the synchronous part of a cleanup.
   * Only a root container reads it. A child container uses the async context of its root.
   */
  asyncContext?: AsyncContext
  /**
   * The keys that do not resolve from the ancestors. The container and its descendants resolve them only from their own registrations.
   * An isolated key also ends the resolution area of an exclusive key of an ancestor.
   */
  isolate?: readonly KeyReference[]
}
