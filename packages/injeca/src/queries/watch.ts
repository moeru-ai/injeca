import type { ContainerNode, ServiceNode } from '../graph/graph'
import type { Container, KeyReference, ServiceState, ServiceStatus } from '../types'

import { effect } from 'alien-signals'

import { BuildAfterDisposeError, InvalidArgumentError, ServiceFailedError } from '../diagnostics/errors'
import { assertActive, demandConsumerService, nodeOf, releaseConsumerDemand } from '../graph/nodes'
import { reportCallbackError } from '../graph/observers'
import { blockingFailure, findProvider, selectProvider } from '../graph/resolvers/resolvers'
import { onAbort, readSignal, waitAbortError } from '../helpers/abort'
import { batch, untracked, withOwner } from '../helpers/signals'
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

/**
 * The effect of one `watch` call. It tracks the provider of `name` and its state. The delivery queue calls the callback untracked.
 *
 * For a `perConsumer` registration, the subscription demands the consumer service of `node`, as `resolve` does. So the state is the real availability for `node`.
 * The demand ends with the subscription.
 */
function subscribe(node: ContainerNode, name: string, callback: (state: ServiceState) => void): () => void {
  const { deliveries } = node.runtime
  const subscription = {}
  let active = true
  let last: ServiceNode | undefined
  let delivered: ServiceState | undefined
  let demand: ServiceNode | undefined
  let demandQueued = false

  const syncDemand = (): void => {
    if (!active)
      return

    const registration = selectProvider(node, name)?.registration
    const next = registration?.perConsumer ? demandConsumerService(registration, node, subscription) : undefined
    if (demand && demand !== next)
      releaseConsumerDemand(demand, subscription)
    demand = next
  }
  batch(syncDemand)

  const stopEffect = withOwner(node.reactiveOwner, () => effect(() => {
    const current = findProvider(node, name)
    // A `perConsumer` registration has no service for this container yet, for example after a replacement. Demand it after this run, outside the effect.
    // A new consumer service, for example after a rebuild, takes over the demand too.
    const moved = demand !== undefined && current?.template !== undefined && current !== demand
    if ((current?.perConsumer || moved) && !demandQueued) {
      demandQueued = true
      queueMicrotask(() => untracked(() => {
        demandQueued = false
        batch(syncDemand)
      }))
    }
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
    if (demand)
      untracked(() => batch(() => releaseConsumerDemand(demand!, subscription)))
    node.disposedListeners.delete(stop)
  }
  node.disposedListeners.add(stop)

  return stop
}

export interface WaitForOptions {
  /** Waits for this effective status. Without it, `waitFor` waits until the key is available: `ready` or `degraded`. */
  status?: ServiceStatus
  /**
   * Ends the wait when the signal aborts. A timeout reason (`name === 'TimeoutError'`) rejects with `wait-timeout`, with the reason as `cause`.
   * Another reason rejects as it is. Use `timeout(container, ms)` for a timeout on the container clock. There is no default.
   */
  signal?: AbortSignal
}

function readWaitOptions(options: WaitForOptions | undefined): { readonly status: ServiceStatus | undefined, readonly signal: AbortSignal | undefined } {
  let status: unknown
  try {
    status = options?.status
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the waitFor options.', { cause: error })
  }
  if (status !== undefined && (typeof status !== 'string' || !statuses.has(status)))
    throw new InvalidArgumentError(`The status option of waitFor must be 'ready', 'degraded', or 'unavailable'. Got ${String(status)}.`)

  return { status: status as ServiceStatus | undefined, signal: readSignal(options, 'waitFor') }
}

/** The failure that ends a wait for `name`: its service is in `failed`, or it waits for a required provider in `failed`. */
function failureOf(node: ContainerNode, name: string): { readonly error: unknown } | undefined {
  const provider = findProvider(node, name)
  if (!provider)
    return undefined

  const phase = provider.signals.phase()
  if (phase === 'failed')
    return provider.failure ?? { error: undefined }
  return phase === 'pending' ? blockingFailure(provider) : undefined
}

/**
 * Resolves with the state of `key` when it is available, or when it has `options.status`.
 *
 * It rejects with `service-failed` when the service is in `failed`, or when it waits for a required provider in `failed`, as `resolve` does.
 * It rejects when `options.signal` aborts, at once for an aborted signal, and when the container is disposed. It has no built-in timeout.
 */
export function waitFor(container: Container, key: WatchKey, options?: WaitForOptions): Promise<ServiceState> {
  const node = nodeOf(container)
  assertActive(node, 'waitFor')
  const name = readKey(key, 'waitFor')
  const { status, signal } = readWaitOptions(options)
  const abortError = (reason: unknown): unknown => waitAbortError(reason, `waitFor('${name}') timed out.`)
  if (signal?.aborted)
    return Promise.reject(abortError(signal.reason))

  const matches = (state: ServiceState): boolean => state.phase === 'running'
    && (status === undefined ? state.status !== undefined && state.status !== 'unavailable' : state.status === status)

  return new Promise((resolve, reject) => untracked(() => {
    let done = false
    let stopWatch: (() => void) | undefined
    let disarm = () => {}
    let stopListening = () => {}

    const onDisposed = (): void => finish(() => reject(new BuildAfterDisposeError(`The container was disposed before waitFor('${name}') matched.`)))

    function finish(outcome: () => void): void {
      if (done)
        return

      done = true
      stopWatch?.()
      stopListening()
      disarm()
      node.disposedListeners.delete(onDisposed)
      outcome()
    }

    node.disposedListeners.add(onDisposed)
    disarm = onAbort(signal, reason => finish(() => reject(abortError(reason))))

    const checkFailure = (): void => {
      const failure = failureOf(node, name)
      if (failure)
        finish(() => reject(new ServiceFailedError(`waitFor('${name}') found a failed service.`, name, { cause: failure.error })))
    }

    // A failure of a dependency does not change the state of `key`. The check runs after each drain, as for `resolve`.
    stopListening = node.runtime.reconciler.onDrained(checkFailure)
    stopWatch = subscribe(node, name, (state) => {
      if (matches(state))
        finish(() => resolve(state))
      else if (state.phase === 'failed')
        checkFailure()
    })
    node.runtime.reconciler.requestDrain()
    // The first state can match at once, before `stopWatch` was assigned.
    if (done)
      stopWatch()
  }))
}
