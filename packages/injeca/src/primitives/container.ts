import type { ContainerNode, Runtime, ServiceNode } from '../graph/graph'
import type { Container, ContainerOptions, EffectSetup, OwnerRecord } from '../types'

import { effectScope, getActiveSub, signal } from 'alien-signals'

import { BuildAfterDisposeError, InvalidArgumentError, ReentrantDisposeError } from '../diagnostics/errors'
import { createDefaultLogger, createNoopLogger } from '../diagnostics/logger'
import { assertActive, nodeOf, registerNode, releaseService } from '../graph/nodes'
import { createCleanupContext } from '../helpers/cleanup-context'
import { systemClock } from '../helpers/clock'
import { createDeliveryQueue } from '../helpers/delivery-queue'
import { errorFrom } from '../helpers/error-from'
import { batch, untracked, withOwner } from '../helpers/signals'
import { abortTransaction } from '../reconciler/commit'
import { createReconciler } from '../reconciler/reconciler'
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

function createRuntime(options: ContainerOptions): Runtime {
  let seq = 0
  let instanceSeq = 0
  const context = createCleanupContext()

  return {
    clock: options.clock ?? systemClock,
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
  const logger = options.enabled === false
    ? createNoopLogger()
    : (options.logger ?? parent?.api.logger ?? createDefaultLogger())
  const runtime = parent?.runtime ?? createRuntime(options)

  let reactiveOwner: ContainerNode['reactiveOwner']
  const stopReactive = withOwner(parent?.reactiveOwner, () => effectScope(() => {
    reactiveOwner = getActiveSub()
  }))

  const api: Container = { logger, owner, parent: parent?.api }
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
    },
    isolated,
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
 */
export function effect(container: Container, setup: EffectSetup): void {
  const node = nodeOf(container)
  assertActive(node, 'add an effect')
  if (typeof setup !== 'function')
    throw new InvalidArgumentError('The effect setup is not a function.')

  const disposer = untracked(setup)
  if (typeof disposer === 'function')
    node.effects.push(disposer)
}

/**
 * Starts the disposal of `container` and of its descendants.
 *
 * The synchronous part withdraws all services of the subtree in the caller's batch, so that dependents stop without a rebuild.
 */
function beginDisposal(container: ContainerNode, parentFrame: ContainerNode['frame']): Promise<void> {
  if (container.disposal)
    return container.disposal

  const { context } = container.runtime
  const frame = { owner: container, parent: parentFrame, active: true }
  container.state = 'disposing'
  container.frame = frame

  // A pending transaction aborts. A build that settles later cannot publish.
  for (const transaction of [...container.transactions])
    void abortTransaction(transaction, new BuildAfterDisposeError('The container was disposed before the transaction committed.'))

  const withdrawn = new Set<ServiceNode>()
  for (const service of container.services) {
    if (service.signals.present()) {
      releaseService(service)
      withdrawn.add(service)
    }
  }

  const children = [...container.children].reverse().map((child) => {
    const disposal = beginDisposal(child, frame)
    // The parent awaits each child later. This branch only stops an early rejection from being reported as unhandled.
    disposal.catch(() => {})
    return disposal
  })

  container.disposal = context.run(frame, async () => {
    const errors: unknown[] = []

    for (const service of [...container.services]) {
      const serviceErrors = await service.withdrawal.promise
      if (withdrawn.has(service))
        errors.push(...serviceErrors)
    }

    for (const child of children) {
      try {
        await child
      }
      catch (error) {
        errors.push(error)
      }
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

/**
 * Withdraws the registrations and invocations of the container, disposes the child containers, and runs the container effects in reverse order.
 *
 * One error keeps its identity. More than one error becomes an `AggregateError`.
 * A call from the cleanup chain of the same container rejects with `reentrant-dispose`. A second call from outside gets the same promise.
 */
export function dispose(container: Container): Promise<void> {
  const node = nodeOf(container)
  const { context } = node.runtime
  if (context.isActive(node))
    return Promise.reject(new ReentrantDisposeError('dispose() was called from the cleanup chain of the same container.'))
  if (node.disposal)
    return node.disposal

  return untracked(() => {
    let disposal: Promise<void> | undefined
    batch(() => {
      disposal = beginDisposal(node, context.current())
    })

    return disposal!
  })
}
