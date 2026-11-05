import type { AsyncContext } from '../types/container'

/**
 * One frame of a container cleanup chain. A frame stays active until the disposal of its container settles.
 */
export interface CleanupFrame {
  readonly owner: object
  readonly parent: CleanupFrame | undefined
  active: boolean
}

/**
 * Tracks the active cleanup frames of calls. Without an async context, it sees only the synchronous part of each call.
 */
export interface CleanupContext {
  current: () => CleanupFrame | undefined
  /** Runs `fn` inside `frame`. Without a frame, runs `fn` outside all frames. */
  run: <T>(frame: CleanupFrame | undefined, fn: () => T) => T
  /** Tells whether the current call descends from the active cleanup of `owner`. */
  isActive: (owner: object) => boolean
}

function activeIn(frame: CleanupFrame | undefined, owner: object): boolean {
  for (let current = frame; current; current = current.parent) {
    if (current.active && current.owner === owner)
      return true
  }

  return false
}

// This context sees only the synchronous part of each cleanup callback, in every runtime.
// Without an async context, injeca does not detect a cleanup that awaits the disposal of its own container after an `await`. A configured stop timeout ends it.
function createSynchronousContext(): CleanupContext {
  let currentFrame: CleanupFrame | undefined

  return {
    current: () => currentFrame,
    run: (frame, fn) => {
      const previous = currentFrame
      currentFrame = frame
      try {
        return fn()
      }
      finally {
        currentFrame = previous
      }
    },
    isActive: owner => activeIn(currentFrame, owner),
  }
}

/**
 * A context on top of an async context that the caller injects, for example `AsyncLocalStorage` in Node.
 * The frame follows a call across `await`, so a cleanup that awaits the disposal of its own container is detected.
 * The store of the async context can hold a value of another library. Only a frame that this context stored counts.
 */
function createAsyncContext(asyncContext: AsyncContext): CleanupContext {
  const frames = new WeakSet<object>()
  const isFrame = (value: unknown): value is CleanupFrame => typeof value === 'object' && value !== null && frames.has(value)
  const current = (): CleanupFrame | undefined => {
    const store = asyncContext.get()
    return isFrame(store) ? store : undefined
  }

  return {
    current,
    run: (frame, fn) => {
      if (frame)
        frames.add(frame)
      return asyncContext.run(frame, fn)
    },
    isActive: owner => activeIn(current(), owner),
  }
}

/** Creates the cleanup context of a runtime. With `asyncContext`, the frames follow calls across `await`. */
export function createCleanupContext(asyncContext?: AsyncContext): CleanupContext {
  return asyncContext ? createAsyncContext(asyncContext) : createSynchronousContext()
}
