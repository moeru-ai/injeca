import {
  invoke as globalInvoke,
  provide as globalProvide,
  resolve as globalResolve,
  setLogger as globalSetLogger,
  start as globalStart,
  stop as globalStop,
} from './global'

export type { Lifecycle } from './builtin'

export type { Logger, LoggerOptions } from './logger'

export {
  createDefaultLogger,
  createLoggLogger,
  createNoopLogger,
} from './logger'

export {
  createContainer,
  invoke,
  lifecycle,
  provide,
  resolve,
  start,
  stop,
} from './scoped'
export type {
  BuildContext,
  Container,
  DependencyMap,
  InvokeOption,
  InvokeOptionFunc,
  InvokeOptionObject,
  InvokeOptionObjectWithKeys,
  InvokeOptionWithKeys,
  ProvidedKey,
  ProvideOption,
  ProvideOptionFunc,
  ProvideOptionObject,
  ProvideOptionObjectWithKeys,
  ProvideOptionWithKeys,
  ResolveDependencyDeclaration,
} from './scoped'

export const injeca = {
  provide: globalProvide,
  invoke: globalInvoke,
  resolve: globalResolve,
  start: globalStart,
  stop: globalStop,
  setLogger: globalSetLogger,
}
