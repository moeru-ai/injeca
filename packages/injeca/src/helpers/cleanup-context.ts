/**
 * One frame of a container cleanup chain. A frame stays active until the disposal of its container settles.
 */
export interface CleanupFrame {
  readonly owner: object
  readonly parent: CleanupFrame | undefined
  active: boolean
}

/**
 * Tracks the active cleanup frames of synchronous calls.
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
// A cleanup must not await the disposal of its own container or of an ancestor.
// injeca does not detect that case after an `await`. A configured stop timeout ends it.
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

export function createCleanupContext(): CleanupContext {
  return createSynchronousContext()
}
