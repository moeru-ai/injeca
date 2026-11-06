import type { ContainerNode, Policy, Runtime, ServiceNode } from '../graph/graph'
import type { Container, ContainerOptions, EffectSetup, OwnerRecord } from '../types'

import { effectScope, getActiveSub, signal } from 'alien-signals'

import { BuildAfterDisposeError, InvalidArgumentError } from '../diagnostics/errors'
import { createDefaultLogger } from '../diagnostics/logger'
import { assertActive, nodeOf, readPolicy, registerNode, releaseService } from '../graph/nodes'
import { recordAbortedWait } from '../graph/observers'
import { abortable, readSignal } from '../helpers/abort'
import { createCleanupContext } from '../helpers/cleanup-context'
import { systemClock } from '../helpers/clock'
import { createDeliveryQueue } from '../helpers/delivery-queue'
import { errorFrom } from '../helpers/error-from'
import { batch, untracked, withOwner } from '../helpers/signals'
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
    services: new Set(),
    signals: {
      started: signal(false),
      slots: new Map(),
      exports: new Map(),
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
 * Starts the disposal of `container` and of its descendants. The whole subtree enters `disposing` at once, so nothing new registers in it.
 *
 * The child containers dispose first, one after the other, in reverse creation order. Then the services of the container withdraw in one batch, so that dependents stop without a rebuild.
 * Then the effects of the container run in reverse order. `after` delays the work until an earlier sibling completed its disposal.
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

  const withdrawn = new Set<ServiceNode>()
  const withdrawServices = (): void => untracked(() => batch(() => {
    for (const service of container.services) {
      if (service.signals.present()) {
        releaseService(service)
        withdrawn.add(service)
      }
    }
  }))
  // Without a child or an earlier sibling, the services withdraw in the caller's batch.
  const immediate = after === undefined && children.length === 0
  if (immediate)
    withdrawServices()

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
      withdrawServices()

    for (const service of [...container.services]) {
      const serviceErrors = await service.withdrawal.promise
      if (withdrawn.has(service))
        errors.push(...serviceErrors)
    }

    for (const disposer of container.effects.splice(0).reverse()) {
      try {
        // A disposer is a user callback.
        await context.run(frame, () => untracked(disposer))
      }
      catch (error) {
        errors.push(error)
      }
    }

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
   * Each service that did not stop yet gets a `wait-aborted` record in the observe stream.
   */
  signal?: AbortSignal
}

/** The services of `container` and of its descendants that did not finish their withdrawal. */
function unfinishedServices(container: ContainerNode): ServiceNode[] {
  return [
    ...[...container.services].filter(service => service.kind !== 'resolver' && service.signals.phase() !== 'withdrawn'),
    ...[...container.children].flatMap(unfinishedServices),
  ]
}

/**
 * Withdraws the registrations and invocations of the container, disposes the child containers, and runs the container effects in reverse order.
 *
 * One error keeps its identity. More than one error becomes an `AggregateError`. A second call from outside without a signal gets the same promise.
 *
 * A call from the cleanup chain of the container or of a descendant cannot wait, because the disposal waits for that cleanup.
 * The same is true for a cleanup of a service that holds a service of the subtree, directly or through other instances, or a consumer service of a `perConsumer` registration of it.
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

  return abortable(disposal, abortSignal, (reason) => {
    recordAbortedWait(unfinishedServices(node), 'dispose', reason)
    return reason
  })
}
