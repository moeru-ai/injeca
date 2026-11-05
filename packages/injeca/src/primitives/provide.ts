import type { ContainerNode, RegistrationNode, ServiceDefinition, ServiceNode } from '../graph/graph'
import type { Container, DependencyDeclarations, DependencyMap, ProvidedKey, ProvideOption, ProvideOptionObject, ProvideOptionWithKeys, Registration, ResolveDependencyDeclaration } from '../types'

import ErrorStackParser from 'error-stack-parser'

import { nanoid } from 'nanoid'

import { DuplicateServiceError, InvalidArgumentError } from '../diagnostics/errors'
import { assertActive, createRegistration, createService, nodeOf, publishService, readDefinition, releaseService } from '../graph/nodes'
import { emitRecord } from '../graph/observers'
import { slotOf } from '../graph/resolvers/resolvers'
import { batch, untracked } from '../helpers/signals'
import { isExclusiveKey, normalizeName } from './keys'
import { registrationApi } from './replace'

export function normalizeProvideOption<D extends DependencyMap | undefined, T = any, Key extends string = string>(nameOrOption: Key | ProvidedKey<Key, T, D> | ProvideOption<T, D> | ProvideOptionWithKeys<T, any>, option?: (ProvideOption<T, D> | ProvideOptionWithKeys<T, any>) & { autoNameStackIndex?: number }): ProvideOptionObject<T, D> {
  if (typeof nameOrOption === 'string') {
    if (option == null || (!('build' in option) && typeof option !== 'function')) {
      throw new Error('When using provide(...) as named callback, the second argument must be either a valid ProvideOptionObject<T, D> or a ProvideOptionFunc<T, D>.')
    }
    if (typeof option === 'function') {
      return { build: option } as ProvideOptionObject<T, D>
    }

    return option as ProvideOptionObject<T, D>
  }
  if (typeof nameOrOption === 'object' && 'key' in nameOrOption) {
    if (option == null || (!('build' in option) && typeof option !== 'function')) {
      throw new Error('When using provide(...) as typed ProvideOptionWithKeys<T, D, Key> callback, the second argument must be either a valid ProvideOptionObject<T, D> or a ProvideOptionFunc<T, D>.')
    }
    if (typeof option === 'function') {
      return { build: option } as ProvideOptionObject<T, D>
    }

    return option as ProvideOptionObject<T, D>
  }

  if (typeof nameOrOption === 'function') {
    return { build: nameOrOption } as ProvideOptionObject<T, D>
  }

  return nameOrOption as ProvideOptionObject<T, D>
}

/** The loose shape of all provide options. The overloads check the types. */
export type ProvideSecondOption = ((context: never) => unknown) | { build: (context: never) => unknown, dependsOn?: unknown, autoNameStackIndex?: number }
/** The loose shape of the first provide argument. The overloads check the types. */
export type ProvideNameOrOption = string | ProvidedKey<string, unknown, DependencyMap | undefined> | ProvideSecondOption

function isProvidedKey(value: unknown): value is ProvidedKey<string, unknown, undefined> {
  return typeof value === 'object' && value !== null && 'key' in value && !('build' in value)
}

function autoName(stackIndex: number, nameOrOption: ProvideNameOrOption, option: ProvideSecondOption | undefined): string {
  const fromFirst = typeof nameOrOption === 'object' && 'autoNameStackIndex' in nameOrOption ? nameOrOption.autoNameStackIndex : undefined
  const fromSecond = typeof option === 'object' ? option.autoNameStackIndex : undefined
  const requested = fromSecond ?? fromFirst
  // `stackIndex` is the frame of the caller of the public `provide`, counted from this function.
  // `autoNameStackIndex` counts from the frame of the public `provide`, as in 0.2.
  const index = typeof requested === 'number' ? requested + stackIndex - 1 : stackIndex
  const parentFile = ErrorStackParser.parse(new Error('providing'))[index]

  return `${parentFile?.fileName ?? `unknown-${nanoid()}`}:${parentFile?.lineNumber ?? 0}:${parentFile?.columnNumber ?? 0}`
}

/** Throws `duplicate-service` when a started container already has a registration for `name`. */
export function assertNoDuplicate(container: ContainerNode, name: string): void {
  if (slotOf(container, name)() && container.signals.started())
    throw new DuplicateServiceError(`The started container already has a registration for '${name}'.`)
}

/**
 * Publishes `service` as the current registration of its key. Call it inside a batch.
 * Before `start()`, a second provide of the same name replaces the first registration, as in 0.2.
 */
export function publishRegistration(container: ContainerNode, service: ServiceNode): void {
  const previous = slotOf(container, service.name)()
  if (previous) {
    releaseService(previous)
    emitRecord(container, {
      type: 'registration-replaced',
      key: service.name,
      owner: container.owner,
      instanceId: previous.signals.instance()?.id,
      reason: `A second provide of '${service.name}' replaced the registration before start().`,
    })
  }

  publishService(service)
}

/** Creates the service of one registration. It is not published yet. */
export function serviceOf(container: ContainerNode, name: string, definition: ServiceDefinition, exclusive: boolean, extra: Pick<Parameters<typeof createService>[0], 'phase' | 'transaction' | 'registration'> = {}): ServiceNode {
  const service = createService({
    container,
    kind: 'service',
    name,
    edges: definition.edges,
    build: definition.build,
    metadata: definition.metadata,
    policy: definition.policy,
    exclusive,
    perConsumer: definition.perConsumer,
    ...extra,
  })
  container.services.add(service)

  return service
}

/** Makes the service of one `provide` call the current registration of its key. */
function register(container: ContainerNode, name: string, definition: ServiceDefinition, exclusive: boolean): RegistrationNode {
  assertNoDuplicate(container, name)

  const registration = createRegistration(container, name, exclusive)
  batch(() => {
    const service = serviceOf(container, name, definition, exclusive, { registration })
    publishRegistration(container, service)
    registration.current = service
  })

  return registration
}

/**
 * Registers a provider. The public `provide` functions call it directly and pass `stackIndex` 3: this function, the auto-name helper, and the public function come before their caller.
 */
export function provideIn(container: Container, stackIndex: number, nameOrOption: ProvideNameOrOption, option?: ProvideSecondOption): Registration<string, unknown, undefined> {
  const node = nodeOf(container)
  assertActive(node, 'provide')

  const name = typeof nameOrOption === 'string'
    ? nameOrOption
    : isProvidedKey(nameOrOption) ? normalizeName(nameOrOption) : autoName(stackIndex, nameOrOption, option)
  if (typeof name !== 'string' || name.length === 0)
    throw new InvalidArgumentError('A provider name must be a non-empty string.')

  const providerObject = normalizeProvideOption(nameOrOption as Parameters<typeof normalizeProvideOption>[0], option as Parameters<typeof normalizeProvideOption>[1])
  const definition = readDefinition(name, providerObject)
  const exclusive = isExclusiveKey(nameOrOption)
  // The name is read above, outside this entry point, so that the stack index of `autoName` stays the same.
  const registration = untracked(() => register(node, name, definition, exclusive))

  container.logger.provide(name, definition.edges.map(edge => edge.keyName))

  return registrationApi(registration)
}

/**
 * Registers a provider and returns its typed key with `withdraw()` and `replace()`.
 *
 * Before `start()`, a second provide of the same name replaces the first registration. After `start()`, it throws `duplicate-service`.
 * After `start()`, a new service builds and starts when its dependencies are available.
 */
export function provide<T, Key extends string, Deps extends DependencyDeclarations>(container: Container, name: Key, option: ProvideOptionWithKeys<T, Deps>): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
export function provide<T, Key extends string, Deps extends DependencyDeclarations>(container: Container, option: ProvideOptionWithKeys<T, Deps> & { autoNameStackIndex?: number }): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
export function provide<D extends DependencyMap | undefined, T = any, Key extends string = string>(container: Container, name: Key, option: ProvideOption<T, D>): Registration<Key, T, D>
export function provide<D extends DependencyMap | undefined, T = any, Key extends string = string>(container: Container, option: ProvideOption<T, D> & { autoNameStackIndex?: number }): Registration<Key, T, D>
export function provide<T, Key extends string, Deps extends DependencyDeclarations>(container: Container, key: ProvidedKey<Key, T, DependencyMap | undefined>, option: ProvideOptionWithKeys<NoInfer<T>, Deps>): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
export function provide<T, Key extends string>(container: Container, key: ProvidedKey<Key, T, DependencyMap | undefined>, option: ProvideOption<NoInfer<T>, undefined>): Registration<Key, T, undefined>
export function provide(container: Container, nameOrOption: ProvideNameOrOption, option?: ProvideSecondOption): Registration<string, unknown, undefined> {
  return provideIn(container, 3, nameOrOption, option)
}
