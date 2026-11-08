import type { ContainerNode, Policy, Runtime, UnitNode } from '../graph/graph'
import type { Container, ContainerOptions, EffectSetup, OwnerRecord } from '../types'

import { effectScope, getActiveSub, signal } from 'alien-signals'

import { BuildAfterDisposeError, HookTimeoutError, InvalidArgumentError } from '../diagnostics/errors'
import { createDefaultLogger } from '../diagnostics/logger'
import { assertActive, nodeOf, readPolicy, registerNode, releaseUnit, timeoutOf } from '../graph/nodes'
import { recordAbortedWait, recordTimeout } from '../graph/observers'
import { abortable, readSignal } from '../helpers/abort'
import { createCleanupContext } from '../helpers/cleanup-context'
import { systemClock } from '../helpers/clock'
import { openDeadline, stopTimeoutWarning } from '../helpers/deadline'
import { createDeliveryQueue } from '../helpers/delivery-queue'
import { errorFrom, messageOf } from '../helpers/error-from'
import { batch, untracked, withOwner } from '../helpers/signals'
import { invokeUser } from '../reconciler/calls'
import { abortTransaction } from '../reconciler/commit'
import { createReconciler } from '../reconciler/reconciler'
import { findReentry, reportReentry } from '../reconciler/reentry'
import { normalizeName } from './keys'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value))
      deepFreeze(child)
  }

  return value
}

function readOwner(owner: unknown): OwnerRecord {
  if (owner === undefined)
    return Object.freeze({})

  let copy: unknown
  try {
    copy = structuredClone(owner)
  }
  catch (error) {
    throw new InvalidArgumentError('The container owner must be a serializable record.', { cause: error })
  }
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy))
    throw new InvalidArgumentError('The container owner must be a serializable record.')

  return deepFreeze(copy as OwnerRecord)
}

function readIsolated(options: ContainerOptions): ReadonlySet<string> {
  let isolate: unknown
  try {
    isolate = options.isolate
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the isolate option.', { cause: error })
  }
  if (isolate === undefined)
    return new Set()
  if (!Array.isArray(isolate))
    throw new InvalidArgumentError('The isolate option must be a list of keys or names.')

  return new Set(isolate.map((key: unknown) => {
    let name: unknown
    try {
      name = normalizeName(key as string)
    }
    catch (error) {
      throw new InvalidArgumentError('Cannot read a key of the isolate option.', { cause: error })
    }
    if (typeof name !== 'string' || name.length === 0)
      throw new InvalidArgumentError('Each entry of the isolate option must be a key or a non-empty name.')

    return name
  }))
}

function readContainerPolicy(options: ContainerOptions): Policy {
  let fields: { maxAttempts: unknown, timeouts: unknown, onTimeout: unknown }
  try {
    fields = { maxAttempts: options.maxAttempts, timeouts: options.timeouts, onTimeout: options.onTimeout }
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the container options.', { cause: error })
  }

  return readPolicy('the container', fields)
}

function readRandom(options: ContainerOptions): () => number {
  let random: unknown
  try {
    random = options.random
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the random option.', { cause: error })
  }
  if (random !== undefined && typeof random !== 'function')
    throw new InvalidArgumentError('The random option must be a function.')

  return (random as (() => number) | undefined) ?? Math.random
}

function readLogging(options: ContainerOptions, parent: ContainerNode | undefined): boolean {
  let logging: unknown
  try {
    logging = options.logging
  }
  catch (error) {
    throw new InvalidArgumentError('Cannot read the logging option.', { cause: error })
  }
  if (logging !== undefined && typeof logging !== 'boolean')
    throw new InvalidArgumentError('The logging option must be a boolean.')

  return (logging as boolean | undefined) ?? parent?.api.logging ?? false
}

function createRuntime(options: ContainerOptions): Runtime {
  let seq = 0
  let instanceSeq = 0
  const context = createCleanupContext()

  return {
    clock: options.clock ?? systemClock,
    random: readRandom(options),
    context,
    deliveries: createDeliveryQueue(),
    observers: new Set(),
    declarations: new Map(),
    reconciler: createReconciler({ context }),
    nextSeq: () => ++seq,
    nextInstanceId: () => `i${++instanceSeq}`,
  }
}

/**
 * Creates a container. With `options.parent`, the container is a child of that container.
 *
 * A child container does not start when it is created, even under a started parent. It waits for `start(child)`.
 */
export function createContainer(options: ContainerOptions = {}): Container {
  const parent = options.parent === undefined ? undefined : nodeOf(options.parent)
  if (parent)
    assertActive(parent, 'create a child container')

  const owner = readOwner(options.owner)
  const isolated = readIsolated(options)
  const policy = readContainerPolicy(options)
  const logging = readLogging(options, parent)
  const logger = options.logger ?? parent?.api.logger ?? createDefaultLogger()
  const runtime = parent?.runtime ?? createRuntime(options)

  let reactiveOwner: ContainerNode['reactiveOwner']
  const stopReactive = withOwner(parent?.reactiveOwner, () => effectScope(() => {
    reactiveOwner = getActiveSub()
  }))

  const api: Container = { logger, logging, owner, parent: parent?.api }
  const node: ContainerNode = {
    seq: runtime.nextSeq(),
    api,
    owner,
    parent,
    runtime,
    children: new Set(),
    units: new Set(),
    signals: {
      started: signal(false),
      slots: new Map(),
      childUnits: new Map(),
    },
    isolated,
    policy,
    listeners: new Map(),
    transactions: new Set(),
    effects: [],
    reactiveOwner: reactiveOwner!,
    stopReactive,
    enrolled: false,
    state: 'active',
    frame: undefined,
    disposal: undefined,
    disposedListeners: new Set(),
  }
  parent?.children.add(node)
  registerNode(api, node)

  return api
}

/**
 * Runs `setup` and stores the returned disposer on the container. `dispose(container)` runs the disposers in reverse order.
 * The `stop` timeout of the container covers them. The disposer gets no signal, so it must not await `stop()` or `dispose()` of its own container.
 *
 * When the disposal of the container started or ended, the disposer runs at once after `setup`, so that the resource does not leak.
 * A disposer that throws throws to the caller. A disposer promise that rejects is reported outside the call, as an unhandled error.
 */
export function effect(container: Container, setup: EffectSetup): void {
  const node = nodeOf(container)
  if (typeof setup !== 'function')
    throw new InvalidArgumentError('The effect setup is not a function.')

  const disposer = untracked(setup)
  if (typeof disposer !== 'function')
    return
  if (node.state === 'active') {
    node.effects.push(disposer)
    return
  }

  const result = untracked(disposer)
  if (result instanceof Promise) {
    result.catch((error: unknown) => queueMicrotask(() => {
      throw error
    }))
  }
}

/**
 * Runs the effects of `container` in reverse order, and returns their errors.
 *
 * The `stop` timeout of the container or of its nearest ancestor covers all of them, as it covers the `stop` hooks and effects of a unit instance. It runs on the container clock.
 * When it passes, injeca warns, sends a `timeout` record with `key: ''`, and stops waiting. The disposal continues and does not fail. `onTimeout` does not run, because a container effect has no hook run.
 * The effect in progress is abandoned. The remaining effects still run, but injeca does not wait for them. A late failure of an abandoned effect goes to `logger.warn`.
 */
async function runEffects(container: ContainerNode, frame: ContainerNode['frame']): Promise<unknown[]> {
  const disposers = container.effects.splice(0).reverse()
  if (disposers.length === 0)
    return []

  const { clock, context } = container.runtime
  const errors: unknown[] = []
  const owner = JSON.stringify(container.owner)
  const timeoutMs = timeoutOf(container, 'stop')
  const deadline = openDeadline({
    clock,
    ms: timeoutMs,
    reason: () => new HookTimeoutError(`The effects of the container ${owner} timed out.`, 'stop', timeoutMs!),
    onTimeout: () => {
      // The container is always disposing, so the warning tells the most common cause.
      container.api.logger.warn(stopTimeoutWarning(`The effects of the container ${owner}`, timeoutMs!, 'disposal', { action: 'disposing', advice: 'A container effect has no signal. It must not await stop() or dispose() of its own container.' }))
      recordTimeout(container, { key: '', instanceId: undefined, hook: 'stop', timeoutMs: timeoutMs!, attempt: 1, reason: `The effects of the container ${owner} did not settle within ${timeoutMs}ms.` })
    },
    onLateFailure: error => container.api.logger.warn(`An effect of the container ${owner} failed after injeca stopped waiting for it: ${messageOf(error)}`),
  })
  // A disposer is a user callback. It runs inside the cleanup frame, so that a `stop()` or `dispose()` from its synchronous part is found.
  for (const disposer of disposers) {
    try {
      await deadline.run(context.run(frame, () => invokeUser(disposer)))
    }
    catch (error) {
      errors.push(error)
    }
  }

  deadline.end()
  return errors
}

/**
 * Starts the disposal of `container` and of its descendants. The whole subtree enters `disposing` at once, so nothing new registers in it.
 *
 * The child containers dispose first, one after the other, in reverse creation order. Then the units of the container withdraw in one batch, so that dependents stop without a rebuild.
 * Then the effects of the container run in reverse order, within the `stop` timeout of the container. `after` delays the work until an earlier sibling completed its disposal.
 */
function beginDisposal(container: ContainerNode, parentFrame: ContainerNode['frame'], after?: Promise<unknown>): Promise<void> {
  if (container.disposal)
    return container.disposal

  const { context } = container.runtime
  const frame = { owner: container, parent: parentFrame, active: true }
  container.state = 'disposing'
  container.frame = frame

  // A pending transaction aborts. A build that settles later cannot publish.
  for (const transaction of [...container.transactions])
    void abortTransaction(transaction, new BuildAfterDisposeError('The container was disposed before the transaction committed.'))

  let previous = after
  const children = [...container.children].reverse().map((child) => {
    const disposal = beginDisposal(child, frame, previous)
    // The parent awaits each child later. This branch only stops an early rejection from being reported as unhandled.
    disposal.catch(() => {})
    previous = disposal.then(() => {}, () => {})
    return disposal
  })

  const withdrawn = new Set<UnitNode>()
  const withdrawUnits = (): void => untracked(() => batch(() => {
    for (const unit of container.units) {
      if (unit.signals.present()) {
        releaseUnit(unit)
        withdrawn.add(unit)
      }
    }
  }))
  // Without a child or an earlier sibling, the units withdraw in the caller's batch.
  const immediate = after === undefined && children.length === 0
  if (immediate)
    withdrawUnits()

  container.disposal = context.run(frame, async () => {
    const errors: unknown[] = []

    if (after)
      await after
    for (const child of children) {
      try {
        await child
      }
      catch (error) {
        errors.push(error)
      }
    }
    if (!immediate)
      withdrawUnits()

    for (const unit of [...container.units]) {
      const unitErrors = await unit.withdrawal.promise
      if (withdrawn.has(unit))
        errors.push(...unitErrors)
    }

    errors.push(...await runEffects(container, frame))

    if (errors.length > 0)
      throw errorFrom(errors, 'Container disposal failed.')
  }).finally(() => {
    frame.active = false
    container.state = 'disposed'
    container.listeners.clear()
    container.stopReactive()
    container.parent?.children.delete(container)
    for (const listener of [...container.disposedListeners]) {
      try {
        listener()
      }
      catch (error) {
        // A subscription cleanup does not change the disposal result. Report it outside the current call stack.
        queueMicrotask(() => {
          throw error
        })
      }
    }
    container.disposedListeners.clear()
  })

  return container.disposal
}

export interface DisposeOptions {
  /**
   * Ends the wait when the signal aborts, and rejects with the reason. The disposal continues in the background. There is no default.
   * Each unit that did not stop yet gets a `wait-aborted` record in the observe stream.
   */
  signal?: AbortSignal
}

/** The units of `container` and of its descendants that did not finish their withdrawal. */
function unfinishedUnits(container: ContainerNode): UnitNode[] {
  return [
    ...[...container.units].filter(unit => unit.kind !== 'resolver' && unit.signals.phase() !== 'withdrawn'),
    ...[...container.children].flatMap(unfinishedUnits),
  ]
}

/**
 * Withdraws the registrations and invocations of the container, disposes the child containers, and runs the container effects in reverse order.
 * The `stop` timeout of the container, or of its nearest ancestor, covers all its effects. At the timeout, injeca warns, sends a `timeout` record with `key: ''`, and the disposal continues.
 *
 * One error keeps its identity. More than one error becomes an `AggregateError`. A second call from outside without a signal gets the same promise.
 *
 * A call from the cleanup chain of the container or of a descendant cannot wait, because the disposal waits for that cleanup.
 * The same is true for a cleanup of a unit that holds a unit of the subtree, directly or through other instances, or a consumer unit of a per-container registration of it.
 * injeca finds such a call by the signal of the cleanup, or by the synchronous part of the cleanup. It warns, sends a `reentrant-call` record, and resolves at once. The disposal continues.
 *
 * When `options.signal` aborts, the call rejects with the reason and stops waiting. The disposal continues: the container stays in `disposing`, and calls on it fail with `build-after-dispose`.
 * A later `dispose()` waits for the same disposal and gets its result. An aborted signal starts the disposal, then rejects at once.
 */
export function dispose(container: Container, options?: DisposeOptions): Promise<void> {
  const node = nodeOf(container)
  const abortSignal = readSignal(options, 'dispose')
  const { context } = node.runtime
  const reentry = untracked(() => findReentry(node, 'dispose', abortSignal))

  const disposal = node.disposal ?? untracked(() => {
    let started: Promise<void> | undefined
    batch(() => {
      started = beginDisposal(node, context.current())
    })

    return started!
  })
  if (reentry) {
    untracked(() => reportReentry(node, 'dispose', reentry))
    // A later `dispose()` gets the result. This call does not report it.
    disposal.catch(() => {})
    return Promise.resolve()
  }

  return abortable(disposal, abortSignal, reason => recordAbortedWait(unfinishedUnits(node), 'dispose', reason))
}
