import {
  getContainer as globalGetContainer,
  invoke as globalInvoke,
  provide as globalProvide,
  resolve as globalResolve,
  setLogger as globalSetLogger,
  start as globalStart,
  stop as globalStop,
} from './global'

export type { InjecaErrorCode, InjecaErrorOptions } from './diagnostics/errors'
export {
  BuildAfterDisposeError,
  DuplicateServiceError,
  ExclusiveConflictError,
  HookOutsideBuildError,
  InjecaError,
  InvalidArgumentError,
  InvalidDecisionError,
  ReentrantDisposeError,
  ReplaceWhileStoppingError,
  StaleRegistrationError,
  StartTimeoutError,
  TransactionIncompleteError,
  WaitTimeoutError,
} from './diagnostics/errors'

export type { Logger, LoggerOptions } from './diagnostics/logger'

export {
  createDefaultLogger,
  createLoggLogger,
  createNoopLogger,
} from './diagnostics/logger'
export type { Clock } from './helpers/clock'

export { systemClock } from './helpers/clock'
export type {
  Decide,
  DecideFor,
  Decision,
  DecisionFor,
  DecisionKind,
  DecisionOptions,
  DecisionSource,
  DependencyHook,
  ExponentialBackoff,
  FailDecision,
  HandledDecision,
  HookDecisionKind,
  HookResult,
  RebuildDecision,
  RequeueDecision,
  RequeueOptions,
  ServiceHook,
  StopDecision,
} from './primitives/decision'

export { observe } from './queries/observe'

export { waitFor, watch } from './queries/watch'
export type { WaitForOptions, WatchKey } from './queries/watch'

export {
  createContainer,
  defineKey,
  dispose,
  effect,
  firstAvailable,
  invoke,
  optional,
  provide,
  resolve,
  start,
  stop,
} from './scoped'

export type { StartOptions } from './scoped'
export type {
  BuildContext,
  Container,
  ContainerOptions,
  DecisionObserveRecord,
  DependencyChange,
  DependencyDeclaration,
  DependencyDeclarations,
  DependencyHookContext,
  DependencyMap,
  DependencySnapshot,
  DependencyState,
  Disposer,
  EffectSetup,
  ErrorObserveRecord,
  FallbackDependency,
  HookContext,
  HookContextFor,
  HookDependencies,
  HookHandler,
  IgnoredObserveRecord,
  InferProvided,
  InvocationContext,
  InvocationHandle,
  InvokeOption,
  InvokeOptionFunc,
  InvokeOptionObject,
  InvokeOptionObjectWithKeys,
  InvokeOptionWithKeys,
  LifecycleContext,
  ObserveRecord,
  ObserveRecordBase,
  OptionalDependency,
  OptionalValue,
  OwnerRecord,
  OwnerValue,
  PhaseObserveRecord,
  ProvidedBy,
  ProvidedKey,
  ProvideOption,
  ProvideOptionFunc,
  ProvideOptionObject,
  ProvideOptionObjectWithKeys,
  ProvideOptionWithKeys,
  Registration,
  RegistrationReplacedObserveRecord,
  ResolveDependencyDeclaration,
  ServiceBlocker,
  ServiceExplanation,
  ServicePhase,
  ServiceState,
  ServiceStatus,
  SetStatusOptions,
  StatusCause,
  StatusObserveRecord,
} from './types'

export const injeca = {
  provide: globalProvide,
  invoke: globalInvoke,
  resolve: globalResolve,
  start: globalStart,
  stop: globalStop,
  setLogger: globalSetLogger,
  getContainer: globalGetContainer,
}
