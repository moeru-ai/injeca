import type { ProviderInfo, ResolutionCondition } from '../../types'
import type { DependencyEdge, ResolutionConsumer, ServiceNode } from '../graph'

import { untracked } from '../../helpers/signals'
import { reportCallbackError } from '../observers'

/**
 * The verdict of each condition for each provider registration.
 * The input of a condition is frozen, and a condition must be pure. So each pair runs once, and a throw is reported once.
 */
const verdicts = new WeakMap<ResolutionCondition, WeakMap<ServiceNode, boolean>>()

/** The read-only information about a provider registration that a condition gets. */
export function providerInfo(registration: ServiceNode): ProviderInfo {
  return Object.freeze({ key: registration.name, owner: registration.container.owner, metadata: registration.metadata })
}

/**
 * Tells whether `condition` accepts the provider registration.
 * A thrown error counts as `false` and goes to the observe stream of the consumer.
 */
export function acceptsProvider(consumer: ResolutionConsumer, keyName: string, condition: ResolutionCondition, registration: ServiceNode): boolean {
  let byProvider = verdicts.get(condition)
  if (!byProvider) {
    byProvider = new WeakMap()
    verdicts.set(condition, byProvider)
  }

  const known = byProvider.get(registration)
  if (known !== undefined)
    return known

  let verdict: boolean
  try {
    // A condition is a user callback.
    verdict = untracked(() => condition(providerInfo(registration))) === true
  }
  catch (error) {
    verdict = false
    // The resolution runs inside a computed value. The record goes out after it, so that no observer runs inside the computation.
    queueMicrotask(() => reportCallbackError(consumer.container, consumer.name, error, `A resolution condition for '${keyName}' threw. It counts as false.`))
  }
  byProvider.set(registration, verdict)

  return verdict
}

/** The resolution conditions that a candidate of `edge` must pass: the condition of the edge, then the condition of the candidate. */
export function conditionsOf(edge: DependencyEdge | undefined, keyName: string): readonly ResolutionCondition[] {
  const conditions: ResolutionCondition[] = []
  if (edge?.condition)
    conditions.push(edge.condition)
  const own = edge?.candidateConditions?.[keyName]
  if (own)
    conditions.push(own)

  return conditions
}

/** Tells whether the provider registration passes each condition of the candidate `keyName` of `edge`. */
export function acceptsCandidate(consumer: ResolutionConsumer, edge: DependencyEdge | undefined, keyName: string, registration: ServiceNode): boolean {
  return conditionsOf(edge, keyName).every(condition => acceptsProvider(consumer, keyName, condition, registration))
}
