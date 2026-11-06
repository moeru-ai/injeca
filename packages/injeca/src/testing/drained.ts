import type { Container } from '../types'

import { nodeOf } from '../graph/nodes'

/**
 * Resolves when the work queue of `container` has drained and stays drained.
 *
 * A build or a hook that settles on a microtask can queue more work after a drain.
 * So it waits one macrotask after each drain, and starts again when another drain happens.
 * The macrotask is a real `setTimeout(0)`, so it does not resolve while the fake timers of a test runner hold `setTimeout`.
 * A `manualClock` does not change `setTimeout`, so the two work together.
 *
 * It does not wait for work that a timer starts later, for example a requeue delay or a policy timeout. Move the clock first, then await `drained` again.
 */
export function drained(container: Container): Promise<void> {
  const { reconciler } = nodeOf(container).runtime

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopListening = reconciler.onDrained(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stopListening()
        resolve()
      }, 0)
    })
    reconciler.requestDrain()
  })
}
