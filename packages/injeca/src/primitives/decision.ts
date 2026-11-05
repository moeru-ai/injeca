import { InvalidDecisionError } from '../diagnostics/errors'

/** The hooks that `on` registers in `build` and in an invocation callback. */
export type ServiceHook = 'start' | 'stop' | 'dependency-change' | 'dependency-status-change'

/** The hooks that run when a dependency changes. Their context has `dependsOn` and `changes`. */
export type DependencyHook = 'dependency-change' | 'dependency-status-change'

export interface DecisionOptions {
  readonly reason?: string
}

export interface ExponentialBackoff {
  readonly kind: 'exponential'
  readonly initial: number
  readonly max: number
  readonly jitter?: number
}

export interface RequeueOptions extends DecisionOptions {
  /** A fixed delay in milliseconds. */
  readonly after?: number
  readonly backoff?: ExponentialBackoff
  readonly maxAttempts?: number
}

/** The fields that injeca fills from the hook context. */
export interface DecisionSource {
  /** The name of the service, or of the invocation. */
  readonly service: string
  readonly instanceId: string
  readonly hook: ServiceHook
  readonly attempt: number
  /** The time of the container clock when `decide` created the decision. */
  readonly issuedAt: number
}

export interface HandledDecision extends DecisionSource, DecisionOptions {
  readonly kind: 'handled'
}

export interface RebuildDecision extends DecisionSource, DecisionOptions {
  readonly kind: 'rebuild'
}

export interface RequeueDecision extends DecisionSource, RequeueOptions {
  readonly kind: 'requeue'
}

export interface StopDecision extends DecisionSource, DecisionOptions {
  readonly kind: 'stop'
}

export interface FailDecision extends DecisionSource, DecisionOptions {
  readonly kind: 'fail'
  readonly error: unknown
}

/**
 * The value that a hook returns to tell injeca what to do next. Only `decide` in the hook context creates it.
 */
export type Decision = HandledDecision | RebuildDecision | RequeueDecision | StopDecision | FailDecision

export type DecisionKind = Decision['kind']

/** The decision kinds that a hook accepts. */
export type HookDecisionKind<H extends ServiceHook>
  = H extends 'start'
    ? 'handled' | 'requeue' | 'stop' | 'fail'
    : H extends 'stop'
      ? 'handled' | 'fail'
      : DecisionKind

/** The decisions that a hook accepts. */
export type DecisionFor<H extends ServiceHook> = Extract<Decision, { readonly kind: HookDecisionKind<H> }>

/**
 * The value that a hook handler can return.
 *
 * A decision tells injeca what to do next. Any other value, for example the result of `app.listen()`, selects the default of the hook.
 * So the shorthand `on('start', () => app.listen(port))` type-checks.
 * The `decide` of each hook has only the methods that the hook accepts. A decision from another run fails at run time with `invalid-decision`.
 */
export type HookResult<_H extends ServiceHook = ServiceHook> = unknown

/** All decision constructors. A hook context has only the constructors that its hook accepts. */
export interface Decide {
  readonly handled: (options?: DecisionOptions) => HandledDecision
  readonly rebuild: (options?: DecisionOptions) => RebuildDecision
  readonly requeue: (options?: RequeueOptions) => RequeueDecision
  readonly stop: (options?: DecisionOptions) => StopDecision
  readonly fail: (error: unknown, options?: DecisionOptions) => FailDecision
}

/** The `decide` object of a hook context. A method that the hook does not accept is a type error. */
export type DecideFor<H extends ServiceHook> = Pick<Decide, HookDecisionKind<H>>

/**
 * One run of one hook handler. Each decision is bound to the run that created it.
 *
 * @internal
 */
export interface HookRun {
  readonly service: string
  readonly instanceId: string
  readonly hook: ServiceHook
  readonly attempt: number
  readonly now: () => number
}

const issued = new WeakMap<object, HookRun>()

function reasonFrom(options: DecisionOptions | undefined): { reason?: string } {
  return options?.reason === undefined ? {} : { reason: options.reason }
}

/** Creates the `decide` object of one run. */
export function createDecide(run: HookRun): Decide {
  function issue<T extends Decision>(fields: Omit<T, keyof DecisionSource>): T {
    const decision = Object.freeze({
      ...fields,
      service: run.service,
      instanceId: run.instanceId,
      hook: run.hook,
      attempt: run.attempt,
      issuedAt: run.now(),
    }) as T
    issued.set(decision, run)
    return decision
  }

  return Object.freeze({
    handled: (options?: DecisionOptions) => issue<HandledDecision>({ kind: 'handled', ...reasonFrom(options) }),
    rebuild: (options?: DecisionOptions) => issue<RebuildDecision>({ kind: 'rebuild', ...reasonFrom(options) }),
    requeue: (options?: RequeueOptions) => issue<RequeueDecision>({
      kind: 'requeue',
      ...reasonFrom(options),
      ...(options?.after === undefined ? {} : { after: options.after }),
      ...(options?.backoff === undefined ? {} : { backoff: Object.freeze({ ...options.backoff }) }),
      ...(options?.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    }),
    stop: (options?: DecisionOptions) => issue<StopDecision>({ kind: 'stop', ...reasonFrom(options) }),
    fail: (error: unknown, options?: DecisionOptions) => issue<FailDecision>({ kind: 'fail', error, ...reasonFrom(options) }),
  })
}

const validKinds: Readonly<Record<ServiceHook, ReadonlySet<DecisionKind>>> = {
  'start': new Set(['handled', 'requeue', 'stop', 'fail']),
  'stop': new Set(['handled', 'fail']),
  'dependency-change': new Set(['handled', 'rebuild', 'requeue', 'stop', 'fail']),
  'dependency-status-change': new Set(['handled', 'rebuild', 'requeue', 'stop', 'fail']),
}

/** The decision for `undefined`. A `dependency-change` handler without a decision gets the default: rebuild. */
export function defaultDecision(run: HookRun): Decision {
  const decide = createDecide(run)
  return run.hook === 'dependency-change' ? decide.rebuild() : decide.handled()
}

/**
 * Checks the value that a hook handler returned. It gives `undefined` for a value that `decide` did not create, so that the caller applies the default.
 * This keeps a shorthand such as `on('start', () => app.listen(port))` valid.
 *
 * @throws {InvalidDecisionError} when another run created the decision, or when the hook does not accept its kind.
 */
export function validateDecision(run: HookRun, value: unknown): Decision | undefined {
  const owner = typeof value === 'object' && value !== null ? issued.get(value) : undefined
  if (!owner)
    return undefined
  if (owner !== run)
    throw new InvalidDecisionError(`The '${run.hook}' hook of '${run.service}' returned a decision from another run: the '${owner.hook}' hook of '${owner.service}', instance '${owner.instanceId}', attempt ${owner.attempt}.`)

  const decision = value as Decision
  if (!validKinds[run.hook].has(decision.kind))
    throw new InvalidDecisionError(`The '${run.hook}' hook cannot return a '${decision.kind}' decision.`)

  return decision
}
