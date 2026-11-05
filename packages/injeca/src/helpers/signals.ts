import { endBatch, setActiveSub, startBatch } from 'alien-signals'

export type ReactiveOwner = ReturnType<typeof setActiveSub>

export interface WritableSignal<T> {
  (): T
  (value: T): void
}

/**
 * Runs `fn` with tracking paused.
 *
 * The tracking rule: each entry point pauses tracking once. The entry points are the public API calls, the reconciler drain, timer callbacks, and the calls of user callbacks.
 * Code inside an entry point reads signals directly. Only the bodies of `computed` and `effect` track.
 * A promise continuation starts with no active subscriber, so it needs no extra pause.
 */
export function untracked<T>(fn: () => T): T {
  const previous = setActiveSub(undefined)
  try {
    return fn()
  }
  finally {
    setActiveSub(previous)
  }
}

/** Writes signals in one batch. Effects see one consistent change. */
export function batch(fn: () => void): void {
  startBatch()
  try {
    fn()
  }
  finally {
    endBatch()
  }
}

/** Runs `fn` with `owner` as the active subscriber, so effects that `fn` creates belong to `owner`. */
export function withOwner<T>(owner: ReactiveOwner, fn: () => T): T {
  const previous = setActiveSub(owner)
  try {
    return fn()
  }
  finally {
    setActiveSub(previous)
  }
}
