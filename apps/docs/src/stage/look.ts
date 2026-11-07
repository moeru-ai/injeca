import type { InstanceView } from '../lab/lab'

// How an instance looks. Ink serves. Blue is a new instance at work. Amber is degraded. Red is a failure.

export type TokenKind
  = | 'ready'
    | 'degraded'
    | 'unavailable'
    | 'building'
    | 'starting'
    | 'retrying'
    | 'stopping'
    | 'pending'
    | 'declared'
    | 'failed'
    | 'conflict'

export function kindOf(view: InstanceView): TokenKind {
  switch (view.phase) {
    case 'running':
      return view.status === 'degraded' ? 'degraded' : view.status === 'unavailable' ? 'unavailable' : 'ready'
    case 'withdrawn':
      return 'stopping'
    default:
      return view.phase
  }
}

/** The word for an instance: its status when it runs and is not ready, or its phase. */
export function wordOf(view: InstanceView): string {
  return view.phase === 'running' && view.status && view.status !== 'ready' ? view.status : view.phase
}

/** The fill of a pulse when a node moves to `kind`. A move to a phase of work has no pulse. */
export function pulseOf(kind: TokenKind): string | undefined {
  switch (kind) {
    case 'ready':
      return 'var(--good-soft)'
    case 'degraded':
      return 'var(--degraded-soft)'
    case 'unavailable':
    case 'failed':
    case 'conflict':
      return 'var(--bad-soft)'
    default:
      return undefined
  }
}
