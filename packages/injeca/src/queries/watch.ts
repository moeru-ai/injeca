import type { ContainerNode, ServiceNode } from '../graph/graph'
import type { Container, KeyReference, ServiceState, ServiceStatus } from '../types'

import { effect } from 'alien-signals'

import { BuildAfterDisposeError, InvalidArgumentError, WaitTimeoutError } from '../diagnostics/errors'
import { assertActive, nodeOf } from '../graph/nodes'
import { reportCallbackError } from '../graph/observers'
import { findProvider } from '../graph/resolvers/resolvers'
import { untracked, withOwner } from '../helpers/signals'
import { withoutUndefined } from '../helpers/without-undefined'
import { normalizeName } from '../primitives/keys'

/** A key name, a key from `defineKey`, or the result of `provide`. */
export type WatchKey = KeyReference

const statuses: ReadonlySet<string> = new Set<ServiceStatus>(['ready', 'degraded', 'unavailable'])

function readKey(key: unknown, action: string): string {
  let name: unknown
  try {
    name = normalizeName(key as string)
  }
  catch (error) {
    throw new InvalidArgumentError(`Cannot read the key of ${action}.`, { cause: error })
  }
  if (typeof name !== 'string' || name.length === 0)
    throw new InvalidArgumentError(`The key of ${action} must be a name or a key.`)

  return name
}

function stateOf(service: ServiceNode | undefined): ServiceState {
  if (!service)
    return Object.freeze({ phase: undefined, status: undefined, instanceId: undefined })

  const status = service.signals.effective()
  return Object.freeze({
    phase: service.signals.phase(),
    status: status?.status,
    instanceId: service.signals.instance()?.id,
    ...withoutUndefined({ reason: status?.reason, cause: status?.cause }),
  })
}

function sameState(a: ServiceState, b: ServiceState): boolean {
  return a.phase === b.phase && a.status === b.status && a.instanceId === b.instanceId && a.reason === b.reason && a.cause === b.cause
}

/**
 * Sends the current phase and effective status of `key` at once, then each change, in order.
 *
 * The key resolves from `container` and its ancestors. After a withdrawal, the callback sees the old service until it is `withdrawn`, or until a new provider appears.
 * A callback error goes to the observe stream. The container owns the subscription: no call follows its disposal. Returns a disposer.
 */
export function watch(container: Container, key: WatchKey, callback: (state: ServiceState) => void): () => void {
  const node = nodeOf(container)
  assertActive(node, 'watch')
  const name = readKey(key, 'watch')
  if (typeof callback !== 'function')
    throw new InvalidArgumentError('The watch callback is not a function.')

  return untracked(() => subscribe(node, name, callback))
}

/** The effect of one `watch` call. It tracks the provider of `name` and its state. The delivery queue calls the callback untracked. */
function subscribe(node: ContainerNode, name: string, callback: (state: ServiceState) => void): () => void {
  const { deliveries } = node.runtime
  let active = true
  let last: ServiceNode | undefined
  let delivered: ServiceState | undefined

  const stopEffect = withOwner(node.reactiveOwner, () => effect(() => {
    const current = findProvider(node, name)
    if (current)
      last = current
    const state = stateOf(current ?? last)
    if (delivered && sameState(delivered, state))
      return

    delivered = state
    deliveries.deliver([{
      run: () => {
        if (active && node.state !== 'disposed')
          callback(state)
      },
      onError: error => reportCallbackError(node, name, error, 'A watch callback threw.'),
    }])
  }))

  const stop = (): void => {
    if (!active)
      return

    active = false
    stopEffect()
    node.disposedListeners.delete(stop)
  }
  node.disposedListeners.add(stop)

  return stop
}

export interface WaitForOptions {
  /** Waits for this effective status. Without it, `waitFor` waits until the key is available: `ready` or `degraded`. */
  status?: ServiceStatus
  /** Rejects with `wait-timeout` after this many milliseconds of the container clock. There is no default. */
  timeoutMs?: number
  /** Rejects with the abort reason when the signal aborts. */
  signal?: AbortSignal
}

function readWaitOptions(options: WaitForOptions | undefined): WaitForOptions {
  let status: unknown
  let timeoutMs: unknown
  let signal: unknown
  try {
    status = options?.status
    timeoutMs = options?.timeoutMs
    signal = options?.signal
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the waitFor options.', { cause: error })
  }
  if (status !== undefined && (typeof status !== 'string' || !statuses.has(status)))
    throw new InvalidArgumentError(`The status option of waitFor must be 'ready', 'degraded', or 'unavailable'. Got ${String(status)}.`)
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0))
    throw new InvalidArgumentError(`The timeoutMs option of waitFor must be a finite number of 0 or more. Got ${String(timeoutMs)}.`)
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new InvalidArgumentError('The signal option of waitFor must be an AbortSignal.')

  return { status: status as ServiceStatus | undefined, timeoutMs: timeoutMs as number | undefined, signal: signal as AbortSignal | undefined }
}

/**
 * Resolves with the state of `key` when it is available, or when it has `options.status`.
 *
 * It rejects on a timeout or an abort, and when the container is disposed. It has no built-in timeout.
 */
export function waitFor(container: Container, key: WatchKey, options?: WaitForOptions): Promise<ServiceState> {
  const node = nodeOf(container)
  assertActive(node, 'waitFor')
  const name = readKey(key, 'waitFor')
  const { status, timeoutMs, signal } = readWaitOptions(options)
  if (signal?.aborted)
    return Promise.reject(signal.reason)

  const matches = (state: ServiceState): boolean => state.phase === 'running'
    && (status === undefined ? state.status !== undefined && state.status !== 'unavailable' : state.status === status)

  return new Promise((resolve, reject) => untracked(() => {
    let done = false
    let stopWatch: (() => void) | undefined
    let cancelTimeout = () => {}

    const onAbort = (): void => finish(() => reject(signal?.reason))
    const onDisposed = (): void => finish(() => reject(new BuildAfterDisposeError(`The container was disposed before waitFor('${name}') matched.`)))

    function finish(outcome: () => void): void {
      if (done)
        return

      done = true
      stopWatch?.()
      cancelTimeout()
      signal?.removeEventListener('abort', onAbort)
      node.disposedListeners.delete(onDisposed)
      outcome()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    node.disposedListeners.add(onDisposed)
    if (timeoutMs !== undefined) {
      cancelTimeout = node.runtime.clock.setTimeout(() => {
        finish(() => reject(new WaitTimeoutError(`waitFor('${name}') timed out after ${timeoutMs}ms.`)))
      }, timeoutMs)
    }

    stopWatch = subscribe(node, name, (state) => {
      if (matches(state))
        finish(() => resolve(state))
    })
    // The first state can match at once, before `stopWatch` was assigned.
    if (done)
      stopWatch()
  }))
}
