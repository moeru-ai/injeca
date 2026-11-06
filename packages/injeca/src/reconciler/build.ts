import type { InstanceNode, StatusValue, UnitNode } from '../graph/graph'
import type { DependencyState } from '../types'
import type { Snapshot } from './snapshot'

import { signal } from 'alien-signals'

import { setPhase } from '../graph/nodes'
import { inConflict } from '../graph/resolvers/exclusive'
import { buildLost, epochOf, requiredAvailable, resolutionOf, resolvedInstance } from '../graph/resolvers/resolvers'
import { batch } from '../helpers/signals'
import { createBuildContext } from './build-context'
import { invokeUser, loggerOf } from './calls'
import { demandProviders } from './demand'
import { syncHolds } from './holds'
import { recordSignalOrigin } from './reentry'
import { currentSnapshot } from './snapshot'
import { runStart } from './start'
import { finalize, mergeIntent, teardown } from './stop'

export type BuildResult = { readonly ok: true, readonly value: unknown } | { readonly ok: false, readonly error: unknown }

/**
 * Tells whether each optional edge has a final answer for a `resolve` call: no provider, a running provider, or a failed one.
 * A unit does not wait for optional edges. A `resolve` call does, so that it does not miss a provider that is still starting.
 */
function optionalSettled(unit: UnitNode): boolean {
  return unit.edges.every((edge) => {
    if (!edge.optional)
      return true

    const resolution = resolutionOf(unit, edge)
    return resolution.kind !== 'not-running' || resolution.provider.signals.phase() === 'failed'
  })
}

/** Builds a pending unit when it is active and its required dependencies are available. An absent one is withdrawn. */
export function reconcilePending(unit: UnitNode): void {
  if (!unit.signals.present()) {
    finalize(unit)
    return
  }
  if (inConflict(unit)) {
    setPhase(unit, 'conflict', { reason: `The exclusive key '${unit.name}' has more than one declaration.` })
    return
  }
  if (!unit.signals.active())
    return

  demandProviders(unit)
  if (!requiredAvailable(unit) || (unit.kind === 'resolver' && !optionalSettled(unit)))
    return
  if (unit.parkedEpoch !== undefined) {
    if (epochOf(unit, edge => resolvedInstance(unit, edge)) === unit.parkedEpoch)
      return
    unit.parkedEpoch = undefined
  }

  beginBuild(unit)
}

function beginBuild(unit: UnitNode): void {
  const instance = prepareInstance(unit, currentSnapshot(unit))
  void runBuild(unit, instance).then(result => completeBuild(unit, instance, result))
}

/** Creates the instance of a build from a snapshot of its dependencies, and moves the unit to `building`. The unit holds each bound provider. */
export function prepareInstance(unit: UnitNode, snapshot: Snapshot): InstanceNode {
  const bindings = new Map<string, InstanceNode>()
  const handled = new Map<string, DependencyState | undefined>()
  for (const [name, entry] of snapshot) {
    handled.set(name, entry?.state)
    if (entry)
      bindings.set(name, entry.instance)
  }

  const instance: InstanceNode = {
    id: unit.container.runtime.nextInstanceId(),
    unit,
    bindings,
    extraHolds: new Set(),
    held: new Set(),
    hooks: { 'start': [], 'stop': [], 'dependency-change': [], 'dependency-status-change': [] },
    hookStates: new Map(),
    handled,
    effects: [],
    controller: new AbortController(),
    signals: {
      holders: signal<ReadonlySet<UnitNode>>(new Set()),
      own: signal<StatusValue>(Object.freeze({ status: 'ready' })),
    },
    hookRun: undefined,
    requeueWait: undefined,
    startFrom: 0,
    value: undefined,
    building: true,
    tearingDown: false,
    disposed: false,
  }

  recordSignalOrigin(instance.controller.signal, instance)
  unit.busy = true
  batch(() => {
    syncHolds(unit, instance)
    unit.signals.instance(instance)
    setPhase(unit, 'building')
  })

  return instance
}

/** Runs `build` for a prepared instance. It never rejects. */
export function runBuild(unit: UnitNode, instance: InstanceNode): Promise<BuildResult> {
  const logger = loggerOf(unit)
  logger?.beforeRun(unit.name)
  const startTime = performance.now()
  const buildContext = createBuildContext(unit, instance)

  return invokeUser(() => unit.build(buildContext)).then(
    (value): BuildResult => {
      logger?.run(unit.name, performance.now() - startTime)
      return { ok: true, value }
    },
    (error: unknown): BuildResult => ({ ok: false, error }),
  )
}

function completeBuild(unit: UnitNode, instance: InstanceNode, result: BuildResult): void {
  instance.building = false
  unit.busy = false

  if (!result.ok) {
    unit.stopIntent = mergeIntent(unit.stopIntent, { failure: { error: result.error }, reason: 'The build failed.' })
    void teardown(unit, instance, false)
    return
  }
  // The target changed during the build. Discard the result now. No `start` hook ran, so no `stop` hook runs.
  if (buildLost(unit, instance)) {
    unit.stopIntent = mergeIntent(unit.stopIntent, { reason: 'The target changed during the build. The result is discarded.' })
    void teardown(unit, instance, false, 'stopping')
    return
  }

  instance.value = result.value
  setPhase(unit, 'starting')
  void runStart(unit, instance)
}
