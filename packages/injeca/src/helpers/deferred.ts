export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}
