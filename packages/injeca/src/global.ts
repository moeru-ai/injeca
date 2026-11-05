import type { Logger } from './diagnostics/logger'
import type { InvokeAnyOption, ProvideNameOrOption, ProvideSecondOption, ResolveOptions, StartOptions } from './scoped'
import type {
  Container,
  DependencyDeclarations,
  DependencyMap,
  InvocationHandle,
  InvokeOption,
  InvokeOptionWithKeys,
  ProvidedKey,
  ProvideOption,
  ProvideOptionWithKeys,
  Registration,
  ResolveDependencyDeclaration,
} from './types'

import { createContainer } from './primitives/container'
import { invokeIn, provideIn, resolve as scopedResolve, start as scopedStart, stop as scopedStop } from './scoped'

let globalContainer = createContainer()

export function setLogger(logger: Logger) {
  globalContainer.logger = logger
}

/** Returns the root container of the global functions. Pass it as `parent` to make a child container. */
export function getContainer(): Container {
  return globalContainer
}

/** Replaces the global container with a new one. `getContainer()` then returns the new one. It does not stop or dispose the old container. */
export function resetContainer() {
  globalContainer = createContainer()
}

export function provide<T, Key extends string, Deps extends DependencyDeclarations>(name: Key, option: ProvideOptionWithKeys<T, Deps>): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
export function provide<D extends DependencyMap | undefined, T = any, Key extends string = string>(name: Key, option: ProvideOption<T, D>): Registration<Key, T, D>
export function provide<T, Key extends string, Deps extends DependencyDeclarations>(option: ProvideOptionWithKeys<T, Deps>): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
export function provide<D extends DependencyMap | undefined, T = any, Key extends string = string>(option: ProvideOption<T, D>): Registration<Key, T, D>
export function provide<T, Key extends string, Deps extends DependencyDeclarations>(key: ProvidedKey<Key, T, DependencyMap | undefined>, option: ProvideOptionWithKeys<NoInfer<T>, Deps>): Registration<Key, T, ResolveDependencyDeclaration<Deps>>
export function provide<T, Key extends string>(key: ProvidedKey<Key, T, DependencyMap | undefined>, option: ProvideOption<NoInfer<T>, undefined>): Registration<Key, T, undefined>
export function provide(nameOrOption: ProvideNameOrOption, option?: ProvideSecondOption): Registration<string, unknown, undefined> {
  return provideIn(globalContainer, 3, nameOrOption, option)
}

export function invoke<Deps extends DependencyDeclarations>(option: InvokeOptionWithKeys<Deps>): InvocationHandle
export function invoke<D extends DependencyMap>(option: InvokeOption<D>): InvocationHandle
export function invoke(option: InvokeAnyOption): InvocationHandle {
  return invokeIn(globalContainer, option)
}

export function resolve<Deps extends DependencyDeclarations>(dependsOn: Deps, options?: ResolveOptions): Promise<ResolveDependencyDeclaration<Deps>> {
  return scopedResolve(globalContainer, dependsOn, options)
}

export function start(options?: StartOptions): Promise<void> {
  return scopedStart(globalContainer, options)
}

export function stop(): Promise<void> {
  return scopedStop(globalContainer)
}
