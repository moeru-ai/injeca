import { describe, expect, it } from 'vitest'

import { createContainer, provide, start, stop, timeout } from '../scoped'
import { drained, manualClock } from './testing'

describe('the public test clock', () => {
  it('drives timeout() without real time', () => {
    const { clock, advance, pending } = manualClock()
    const app = createContainer({ enabled: false, clock })
    const signal = timeout(app, 1_000)

    advance(999)
    expect(signal.aborted).toBe(false)
    expect(pending()).toBe(1)
    advance(1)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
    expect(pending()).toBe(0)
    expect(clock.now()).toBe(1_000)
  })

  it('drives a policy stop timeout with drained', async () => {
    const { clock, advance } = manualClock()
    const app = createContainer({ enabled: false, clock, timeouts: { stop: 100 } })
    provide(app, 'airi.tray', ({ on }) => {
      on('stop', () => new Promise<void>(() => {}))
      return 'tray'
    })
    await start(app)

    let stopped = false
    void stop(app).then(() => {
      stopped = true
    })
    await drained(app)
    expect(stopped).toBe(false)
    advance(100)
    await drained(app)
    expect(stopped).toBe(true)
  })
})
