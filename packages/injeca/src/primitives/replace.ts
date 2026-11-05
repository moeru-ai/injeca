import type { RegistrationNode, ServiceDefinition, ServiceNode, SwapOutcome } from '../graph/graph'
import type { Registration } from '../types'

import { ReplaceWhileStoppingError } from '../diagnostics/errors'
import { cancelPending, createService, currentService, publishService, readDefinition, releaseService, withdrawRegistration } from '../graph/nodes'
import { createDeferred } from '../helpers/deferred'
import { errorFrom } from '../helpers/error-from'
import { batch, untracked } from '../helpers/signals'

/** A new service that waits for its swap, with the outcome of the swap. */
interface PendingSwap {
  readonly service: ServiceNode
  readonly outcome: Promise<SwapOutcome>
}

/**
 * Creates a new service that replaces `target` after it completes `start`. It is not published before the swap.
 * `onSwap` runs at the swap, before the outcome settles.
 */
export function createSuccessor(target: ServiceNode, definition: ServiceDefinition, template: ServiceNode | undefined, onSettle: (service: ServiceNode, outcome: SwapOutcome) => void, extra: Pick<Parameters<typeof createService>[0], 'phase' | 'transaction'> = {}): PendingSwap {
  const outcome = createDeferred<SwapOutcome>()
  let settled = false
  let service: ServiceNode | undefined

  batch(() => {
    service = createService({
      container: target.container,
      kind: 'service',
      name: target.name,
      edges: definition.edges,
      build: definition.build,
      metadata: definition.metadata,
      policy: definition.policy,
      exclusive: target.exclusive,
      template,
      consumer: target.consumer,
      registration: target.registration,
      ...extra,
      swap: {
        target,
        settle: (result) => {
          if (settled)
            return

          settled = true
          onSettle(service!, result)
          outcome.resolve(result)
        },
      },
    })
    service.signals.demanded(target.signals.demanded())
    target.container.services.add(service)
  })

  return { service: service!, outcome: outcome.promise }
}

function outcomeResult(outcome: SwapOutcome, name: string): boolean {
  switch (outcome.kind) {
    case 'swapped':
      return true
    case 'cancelled':
      return false
    case 'failed':
      throw outcome.error
    case 'stopping':
      throw new ReplaceWhileStoppingError(`'${name}' started to stop before its replacement completed.`)
  }
}

/** Makes `service` the current registration in place of `target`, in the caller's batch. */
export function takeOver(registration: RegistrationNode, target: ServiceNode, service: ServiceNode): void {
  cancelPending(registration)
  target.replacedBy = service
  releaseService(target)
  publishService(service)
  registration.current = service
}

/** Replaces a service that has no serving instance. The new service takes the slot at once. */
export function replaceAtOnce(registration: RegistrationNode, target: ServiceNode, definition: ServiceDefinition): ServiceNode {
  let service: ServiceNode | undefined
  batch(() => {
    service = createService({
      container: target.container,
      kind: 'service',
      name: target.name,
      edges: definition.edges,
      build: definition.build,
      metadata: definition.metadata,
      policy: definition.policy,
      exclusive: target.exclusive,
      perConsumer: target.perConsumer,
      registration,
    })
    service.signals.demanded(target.signals.demanded())
    target.container.services.add(service)
    takeOver(registration, target, service)
  })

  return service!
}

/**
 * Moves the consumer services of the `perConsumer` registration `target` to `template`, in the caller's batch.
 * Each running consumer service gets a new service that swaps in after it completes `start`. The others leave and build again on demand.
 */
export function moveConsumers(registration: RegistrationNode, target: ServiceNode, template: ServiceNode, definition: ServiceDefinition): PendingSwap[] {
  const consumers = target.signals.consumers()
  target.signals.consumers(new Map())
  takeOver(registration, target, template)

  const swaps: PendingSwap[] = []
  const kept = new Map<ServiceNode['container'], ServiceNode>()
  for (const [container, consumer] of consumers) {
    consumer.template = template
    if (consumer.signals.serving()) {
      kept.set(container, consumer)
      swaps.push(createSuccessor(consumer, definition, template, () => {}))
    }
    else {
      consumer.signals.present(false)
    }
  }
  template.signals.consumers(kept)

  return swaps
}

/** Replaces a `perConsumer` registration. The new registration takes the slot at once. Its consumer services swap in one by one. */
export function replaceRegistrationTemplate(registration: RegistrationNode, target: ServiceNode, definition: ServiceDefinition): readonly PendingSwap[] {
  let swaps: PendingSwap[] = []
  batch(() => {
    const template = createService({
      container: target.container,
      kind: 'service',
      name: target.name,
      edges: definition.edges,
      build: definition.build,
      metadata: definition.metadata,
      policy: definition.policy,
      exclusive: target.exclusive,
      perConsumer: true,
      registration,
    })
    target.container.services.add(template)
    swaps = moveConsumers(registration, target, template, definition)
  })

  return swaps
}

/** Settles a replacement for its registration. */
function settleRegistration(registration: RegistrationNode): (service: ServiceNode, outcome: SwapOutcome) => void {
  return (service, outcome) => {
    if (registration.pending === service)
      registration.pending = undefined
    if (outcome.kind === 'swapped')
      registration.current = service
  }
}

/**
 * Starts the replacement of a running service. The old instance serves until the new one completes `start`.
 * A transaction passes `extra`, and it sets `registration.pending` at its publish.
 */
export function replaceRunning(registration: RegistrationNode, target: ServiceNode, definition: ServiceDefinition, extra?: Pick<Parameters<typeof createService>[0], 'phase' | 'transaction'>): PendingSwap {
  const pending = createSuccessor(target, definition, undefined, settleRegistration(registration), extra)
  if (!extra?.transaction) {
    cancelPending(registration)
    registration.pending = pending.service
  }

  return pending
}

/** The `replace()` of a registration. */
async function replace(registration: RegistrationNode, option: unknown): Promise<boolean> {
  const target = untracked(() => currentService(registration))
  if (!target)
    return false

  const definition = readDefinition(registration.name, option, target)
  const phase = untracked(() => target.signals.phase())
  if (phase === 'stopping')
    throw new ReplaceWhileStoppingError(`'${registration.name}' is stopping. Wait until it stops, then call provide.`)

  if (target.perConsumer) {
    const swaps = untracked(() => replaceRegistrationTemplate(registration, target, definition))
    const outcomes = await Promise.all(swaps.map(swap => swap.outcome))
    const errors = outcomes.flatMap(outcome => outcome.kind === 'failed' ? [outcome.error] : [])
    if (errors.length > 0)
      throw errorFrom(errors, `The replacement of '${registration.name}' failed for some consumers.`)
    return true
  }
  if (phase !== 'running') {
    untracked(() => replaceAtOnce(registration, target, definition))
    return true
  }

  const pending = untracked(() => replaceRunning(registration, target, definition))
  return outcomeResult(await pending.outcome, registration.name)
}

const registrations = new WeakMap<object, RegistrationNode>()

/** The registration behind a result of `provide`, or `undefined` for any other value. */
export function registrationOf(key: unknown): RegistrationNode | undefined {
  return typeof key === 'object' && key !== null ? registrations.get(key) : undefined
}

/** Creates the public result of `provide`: the typed key with `withdraw()` and `replace()`. */
export function registrationApi(registration: RegistrationNode): Registration<string, unknown, undefined> {
  const api: Registration<string, unknown, undefined> = Object.freeze({
    key: registration.name,
    ...(registration.exclusive ? { exclusive: true } : {}),
    withdraw: () => withdrawRegistration(registration),
    replace: ((option: unknown) => replace(registration, option)) as Registration<string, unknown, undefined>['replace'],
  })
  registrations.set(api, registration)

  return api
}
