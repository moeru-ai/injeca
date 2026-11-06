import type { InstanceNode, ServiceNode, StatusValue } from '../graph/graph'
import type { DependencyState } from '../types'
import type { Snapshot } from './snapshot'

import { signal } from 'alien-signals'

import { ensureConsumerService, setPhase } from '../graph/nodes'
import { inConflict } from '../graph/resolvers/exclusive'
import { buildLost, candidatesOf, epochOf, requiredAvailable, resolutionOf, resolvedInstance } from '../graph/resolvers/resolvers'
import { batch } from '../helpers/signals'
import { createBuildContext } from './build-context'
import { invokeUser, loggerOf } from './calls'
import { syncHolds } from './holds'
import { currentSnapshot } from './snapshot'
import { runStart } from './start'
import { finalize, mergeIntent, teardown } from './stop'

export type BuildResult = { readonly ok: true, readonly value: unknown } | { readonly ok: false, readonly error: unknown }

/**
 * An active service makes the providers of its edges converge too, before `start()`. A fallback edge demands each candidate.
 * A `perConsumer` registration gets a service for the scope of `service`. The nearest registration of each key is demanded.
 */
function demandProviders(service: ServiceNode): void {
  for (const edge of service.edges) {
    for (const keyName of edge.candidates) {
      const candidates = candidatesOf(service.scope, keyName, service)
      const providers = candidates.map(registration => registration.perConsumer ? ensureConsumerService(registration, service.scope, service) : registration)
      const [nearest] = providers
      if (nearest && !nearest.signals.serving() && !nearest.signals.demanded())
        nearest.signals.demanded(true)
    }
  }
}

/**
 * Tells whether each optional edge has a final answer for a `resolve` call: no provider, a running provider, or a failed one.
 * A service does not wait for optional edges. A `resolve` call does, so that it does not miss a provider that is still starting.
 */
function optionalSettled(service: ServiceNode): boolean {
  return service.edges.every((edge) => {
    if (!edge.optional)
      return true

    const resolution = resolutionOf(service, edge)
    return resolution.kind !== 'not-running' || resolution.provider.signals.phase() === 'failed'
  })
}

/** Builds a pending service when it is active and its required dependencies are available. An absent one is withdrawn. */
export function reconcilePending(service: ServiceNode): void {
  if (!service.signals.present()) {
    finalize(service)
    return
  }
  if (inConflict(service)) {
    setPhase(service, 'conflict', { reason: `The exclusive key '${service.name}' has more than one declaration.` })
    return
  }
  if (!service.signals.active())
    return

  demandProviders(service)
  if (!requiredAvailable(service) || (service.kind === 'resolver' && !optionalSettled(service)))
    return
  if (service.parkedEpoch !== undefined) {
    if (epochOf(service, edge => resolvedInstance(service, edge)) === service.parkedEpoch)
      return
    service.parkedEpoch = undefined
  }

  beginBuild(service)
}

function beginBuild(service: ServiceNode): void {
  const instance = prepareInstance(service, currentSnapshot(service))
  void runBuild(service, instance).then(result => completeBuild(service, instance, result))
}

/** Creates the instance of a build from a snapshot of its dependencies, and moves the service to `building`. The service holds each bound provider. */
export function prepareInstance(service: ServiceNode, snapshot: Snapshot): InstanceNode {
  const bindings = new Map<string, InstanceNode>()
  const handled = new Map<string, DependencyState | undefined>()
  for (const [name, entry] of snapshot) {
    handled.set(name, entry?.state)
    if (entry)
      bindings.set(name, entry.instance)
  }

  const instance: InstanceNode = {
    id: service.container.runtime.nextInstanceId(),
    service,
    bindings,
    extraHolds: new Set(),
    held: new Set(),
    hooks: { 'start': [], 'stop': [], 'dependency-change': [], 'dependency-status-change': [] },
    hookStates: new Map(),
    handled,
    effects: [],
    controller: new AbortController(),
    signals: {
      holders: signal<ReadonlySet<ServiceNode>>(new Set()),
      own: signal<StatusValue>(Object.freeze({ status: 'ready' })),
    },
    hookRun: undefined,
    requeueWait: undefined,
    startFrom: 0,
    value: undefined,
    building: true,
    disposed: false,
  }

  service.busy = true
  batch(() => {
    syncHolds(service, instance)
    service.signals.instance(instance)
    setPhase(service, 'building')
  })

  return instance
}

/** Runs `build` for a prepared instance. It never rejects. */
export function runBuild(service: ServiceNode, instance: InstanceNode): Promise<BuildResult> {
  const logger = loggerOf(service)
  logger?.beforeRun(service.name)
  const startTime = performance.now()
  const buildContext = createBuildContext(service, instance)

  return invokeUser(() => service.build(buildContext)).then(
    (value): BuildResult => {
      logger?.run(service.name, performance.now() - startTime)
      return { ok: true, value }
    },
    (error: unknown): BuildResult => ({ ok: false, error }),
  )
}

function completeBuild(service: ServiceNode, instance: InstanceNode, result: BuildResult): void {
  instance.building = false
  service.busy = false

  if (!result.ok) {
    service.stopIntent = mergeIntent(service.stopIntent, { failure: { error: result.error }, reason: 'The build failed.' })
    void teardown(service, instance, false)
    return
  }
  // The target changed during the build. Discard the result now. No `start` hook ran, so no `stop` hook runs.
  if (buildLost(service, instance)) {
    service.stopIntent = mergeIntent(service.stopIntent, { reason: 'The target changed during the build. The result is discarded.' })
    void teardown(service, instance, false, 'stopping')
    return
  }

  instance.value = result.value
  setPhase(service, 'starting')
  void runStart(service, instance)
}
