import type { Logger } from '../diagnostics/logger'
import type { WatchKey } from '../queries/watch'
import type { BuildContext, Container, ContainerOptions, ObserveRecord, UnitPhase, UnitState } from '../types'

import { createNoopLogger } from '../diagnostics/logger'
import { createContainer } from '../primitives/container'
import { provide } from '../primitives/provide'
import { observe } from '../queries/observe'
import { watch } from '../queries/watch'

export { drained } from './drained'
export { manualClock } from './manual-clock'
export type { ManualClock } from './manual-clock'

export interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

/** Creates a container for a test. It writes nothing, also no warnings, unless `logger` is set. */
export function createTestContainer(options: ContainerOptions = {}): Container {
  return createContainer({ ...options, logger: options.logger ?? createNoopLogger() })
}

/** A logger that writes nothing and collects the messages of `warn`. */
export function warningLogger(): { readonly logger: Logger, readonly warnings: string[] } {
  const warnings: string[] = []
  return { logger: { ...createNoopLogger(), warn: message => warnings.push(message) }, warnings }
}

/** Reads the current state of a key. `watch` sends it at once. */
export function stateOf(container: Container, key: WatchKey): UnitState {
  let current: UnitState | undefined
  watch(container, key, (state) => {
    current = state
  })()

  return current!
}

/**
 * Reads the current phase of a key, as a plain string.
 *
 * The public API has no phase getter. A caller subscribes with `watch`. This helper takes one state from `watch` and stops.
 */
export function phaseOf(container: Container, key: WatchKey): UnitPhase | undefined {
  return stateOf(container, key).phase
}

/** Collects the observe stream of `container` into `records`. */
export function collectRecords(container: Container): { readonly records: ObserveRecord[], readonly stop: () => void } {
  const records: ObserveRecord[] = []
  const stop = observe(container, entry => records.push(entry))
  return { records, stop }
}

/** Provides `name` with a build that keeps its `setStatus`, so that a test can change the status later. `stop` becomes a stop hook. */
export function provideWithStatus(app: Container, name: string, stop?: () => void) {
  const handle: { setStatus: BuildContext['setStatus'] } = { setStatus: () => {} }
  const registration = provide(app, name, ({ setStatus, on }) => {
    handle.setStatus = setStatus
    if (stop)
      on('stop', stop)
    return name
  })

  return Object.assign(handle, { registration })
}

/**
 * Creates an `AbortController` whose signal counts its `abort` listeners. `listeners()` is the number of listeners that were added and not removed.
 * A `once` listener counts as removed after the abort.
 */
export function trackedController(): { readonly controller: AbortController, readonly signal: AbortSignal, readonly listeners: () => number } {
  const controller = new AbortController()
  const { signal } = controller
  const active = new Set<unknown>()
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
    if (type === 'abort')
      active.add(listener)
    add(type, listener, options)
  }) as AbortSignal['addEventListener']
  signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => {
    if (type === 'abort')
      active.delete(listener)
    remove(type, listener, options)
  }) as AbortSignal['removeEventListener']
  add('abort', () => active.clear(), { once: true })

  return { controller, signal, listeners: () => active.size }
}
