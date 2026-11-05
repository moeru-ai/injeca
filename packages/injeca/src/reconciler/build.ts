import type { InstanceNode, ServiceNode, StatusValue } from '../graph/graph'
import type { DependencyState } from '../types'

import { signal } from 'alien-signals'

import { setPhase } from '../graph/nodes'
import { buildLost, epochOf, findProvider, requiredAvailable, resolutionOf, resolvedInstance } from '../graph/resolvers/resolvers'
import { batch } from '../helpers/signals'
import { createBuildContext } from './build-context'
import { invokeUser, loggerOf } from './calls'
import { syncHolds } from './holds'
import { currentSnapshot } from './snapshot'
import { runStart } from './start'
import { finalize, mergeIntent, teardown } from './stop'

type BuildResult = { readonly ok: true, readonly value: unknown } | { readonly ok: false, readonly error: unknown }

/** An active service makes the providers of its edges converge too, before `start()`. A fallback edge demands each candidate. */
function demandProviders(service: ServiceNode): void {
  for (const edge of service.edges) {
    for (const keyName of edge.candidates) {
      const provider = findProvider(service.container, keyName, service)
      if (provider && !provider.signals.serving() && !provider.signals.demanded())
        provider.signals.demanded(true)
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
  const bindings = new Map<string, InstanceNode>()
  const handled = new Map<string, DependencyState | undefined>()
  for (const [name, entry] of currentSnapshot(service)) {
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

  const logger = loggerOf(service)
  logger?.beforeRun(service.name)
  const startTime = performance.now()
  const buildContext = createBuildContext(service, instance)
  invokeUser(() => service.build(buildContext)).then(
    (value) => {
      logger?.run(service.name, performance.now() - startTime)
      completeBuild(service, instance, { ok: true, value })
    },
    (error: unknown) => completeBuild(service, instance, { ok: false, error }),
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
