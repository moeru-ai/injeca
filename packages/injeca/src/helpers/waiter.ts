import { untracked } from './signals'

/** A wait that settles once. */
export interface Waiter<T> {
  readonly promise: Promise<T>
  /** Settle the wait. Only the first call has an effect. The removers run before the promise settles. */
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
  readonly settled: () => boolean
  /** Adds a remover, for example of a listener. After the wait settled, the remover runs at once. */
  readonly defer: (remove: () => void) => void
}

/**
 * Creates a wait. When `signal` aborts first, it rejects with the result of `reasonOf`. An aborted signal rejects at once.
 * Each API gives its own `reasonOf`, because the APIs map the abort reason in different ways.
 */
export function createWaiter<T>(signal: AbortSignal | undefined, reasonOf: (reason: unknown) => unknown = reason => reason): Waiter<T> {
  let done = false
  const removers: Array<() => void> = []
  let settle!: { readonly resolve: (value: T) => void, readonly reject: (error: unknown) => void }
  const promise = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject }
  })
  const finish = (outcome: () => void): void => {
    if (done)
      return

    done = true
    for (const remove of removers.splice(0))
      remove()
    outcome()
  }

  const waiter: Waiter<T> = {
    promise,
    resolve: value => finish(() => settle.resolve(value)),
    reject: error => finish(() => settle.reject(error)),
    settled: () => done,
    defer: remove => done ? remove() : void removers.push(remove),
  }
  if (signal?.aborted)
    waiter.reject(reasonOf(signal.reason))
  else
    waiter.defer(onAbort(signal, reason => waiter.reject(reasonOf(reason))))

  return waiter
}

/** Calls `callback` with the reason when `signal` aborts. Returns a function that removes the listener. The callback is an entry point, so it runs untracked. */
export function onAbort(signal: AbortSignal | undefined, callback: (reason: unknown) => void): () => void {
  if (!signal)
    return () => {}

  const listener = (): void => untracked(() => callback(signal.reason))
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}
