import type { Decision, FailDecision, HandledDecision, ServiceHook } from '../primitives/decision'
import type { BuildContext, DependencyChange, DependencySnapshot, GraphService, LifecycleContext, ListenerEntry, OptionalValue, OwnerRecord, PolicyOptions, ProviderInfo, Registration, ResolveDependencyDeclaration, ServiceState, ServiceStatus, WithdrawOptions } from './index'

import { describe, expectTypeOf, it } from 'vitest'

import { waitFor, watch } from '../queries/watch'
import { createContainer, defineKey, firstAvailable, graph, invoke, listeners, optional, provide, resolve, timeout, transaction, where, withTimeout } from '../scoped'
import { createHookContext } from '../testing/testing'

// Design test 35. The checks run in `pnpm typecheck`. The cases do not start the container.

interface Llm {
  chat: () => string
}

interface Tts {
  speak: () => void
}

describe('call-site types', () => {
  it('infers the key type of provide by name from build', () => {
    const app = createContainer()
    const llm = provide(app, 'airi.llm', { build: (): Llm => ({ chat: () => 'hi' }) })
    const shorthand = provide(app, 'airi.count', () => 1)
    const asyncShorthand = provide(app, 'airi.async', async () => 'value')

    expectTypeOf(llm.key).toEqualTypeOf<'airi.llm'>()
    expectTypeOf(resolve(app, { llm, shorthand, asyncShorthand })).resolves.toEqualTypeOf<{ llm: Llm, shorthand: number, asyncShorthand: string }>()
    expectTypeOf(llm.withdraw).returns.resolves.toEqualTypeOf<boolean>()
    expectTypeOf(llm.withdraw).parameter(0).toEqualTypeOf<WithdrawOptions | undefined>()
  })

  it('infers each dependsOn value, and types an optional dependency as { value, status } | undefined', () => {
    const app = createContainer()
    const llm = provide(app, 'airi.llm', (): Llm => ({ chat: () => 'hi' }))
    const ttsKey = defineKey<Tts>('airi.tts')

    provide(app, 'voice.speech', {
      dependsOn: { llm, tts: optional(ttsKey), named: 'airi.named' },
      build: ({ dependsOn, on, effect, signal, instanceId }) => {
        expectTypeOf(dependsOn.llm).toEqualTypeOf<Llm>()
        expectTypeOf(dependsOn.tts).toEqualTypeOf<OptionalValue<Tts> | undefined>()
        expectTypeOf(dependsOn.tts?.value).toEqualTypeOf<Tts | undefined>()
        expectTypeOf(on).toEqualTypeOf<LifecycleContext<ResolveDependencyDeclaration<{ llm: typeof llm, tts: ReturnType<typeof optional<Tts>>, named: string }>>['on']>()
        expectTypeOf(effect).toEqualTypeOf<BuildContext['effect']>()
        expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
        expectTypeOf(instanceId).toEqualTypeOf<string>()
        // @ts-expect-error An undeclared dependency is an error.
        return dependsOn.missing
      },
    })

    invoke(app, {
      dependsOn: { llm },
      callback: ({ llm }, { signal }) => {
        expectTypeOf(llm).toEqualTypeOf<Llm>()
        expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
      },
    })
  })

  it('checks the build result against the type of a defineKey key', () => {
    const app = createContainer()
    const ttsKey = defineKey<Tts>('airi.tts')
    const llm = provide(app, 'airi.llm', (): Llm => ({ chat: () => 'hi' }))

    const tts = provide(app, ttsKey, () => ({ speak: () => {} }))
    expectTypeOf(resolve(app, { tts })).resolves.toEqualTypeOf<{ tts: Tts }>()

    provide(app, ttsKey, {
      dependsOn: { llm },
      build: ({ dependsOn }) => ({ speak: () => void dependsOn.llm.chat() }),
    })

    // @ts-expect-error A wrong build result for a defineKey key is an error.
    provide(app, ttsKey, () => ({ speak: 'not a function' }))
    // @ts-expect-error A wrong build result in the object form is an error.
    provide(app, ttsKey, { dependsOn: { llm }, build: () => 42 })
  })

  it('types the hook context of each hook', () => {
    const app = createContainer()
    const llm = provide(app, 'airi.llm', (): Llm => ({ chat: () => 'hi' }))
    const ttsKey = defineKey<Tts>('airi.tts')

    provide(app, 'voice.speech', {
      dependsOn: { llm, tts: optional(ttsKey) },
      build: ({ on, setStatus }) => {
        expectTypeOf(setStatus).parameter(0).toEqualTypeOf<ServiceStatus>()

        on('start', ({ decide, attempt, previous, signal }) => {
          expectTypeOf(attempt).toEqualTypeOf<number>()
          expectTypeOf(signal).toEqualTypeOf<AbortSignal>()
          expectTypeOf(previous?.kind).toEqualTypeOf<'handled' | 'requeue' | 'stop' | 'fail' | undefined>()
          expectTypeOf(decide).toHaveProperty('requeue')
          // @ts-expect-error A start hook cannot rebuild.
          void decide.rebuild
          return decide.requeue({ after: 1, maxAttempts: 2 })
        })

        // Design test 39.
        on('stop', (context) => {
          const { decide } = context
          // @ts-expect-error A stop hook has no requeue.
          void decide.requeue
          // @ts-expect-error A stop hook has no rebuild.
          void decide.rebuild
          // @ts-expect-error A stop hook has no stop.
          void decide.stop
          // @ts-expect-error A stop hook has no dependency snapshot.
          void context.dependsOn
          return decide.handled()
        })
        // Shorthand: a value that is not a decision type-checks and selects the default of the hook.
        on('start', () => ({ address: () => '127.0.0.1' }))
        on('stop', async () => 8080)

        on('dependency-change', ({ decide, dependsOn, changes }) => {
          expectTypeOf(dependsOn.llm).toEqualTypeOf<DependencySnapshot<Llm>>()
          expectTypeOf(dependsOn.llm.instanceId).toEqualTypeOf<string>()
          expectTypeOf(dependsOn.tts).toEqualTypeOf<DependencySnapshot<Tts> | undefined>()
          expectTypeOf(dependsOn.tts?.status).toEqualTypeOf<ServiceStatus | undefined>()
          expectTypeOf(changes).toEqualTypeOf<readonly DependencyChange[]>()
          expectTypeOf(decide).toHaveProperty('rebuild')
          return dependsOn.tts ? decide.handled() : decide.rebuild()
        })

        on('dependency-status-change', ({ decide, dependsOn, attempt }) => {
          if (dependsOn.tts?.status !== 'ready' && attempt < 10)
            return decide.requeue({ after: 1_000, reason: 'TTS is warming up' })
          return decide.handled()
        })

        // @ts-expect-error An unknown hook is an error.
        on('restart', () => {})
        return 'speech'
      },
    })

    invoke(app, {
      dependsOn: { llm },
      callback: (_, { on }) => {
        on('dependency-change', ({ dependsOn, decide }) => {
          expectTypeOf(dependsOn.llm.value).toEqualTypeOf<Llm>()
          return decide.handled()
        })
      },
    })
  })

  it('types decisions, firstAvailable, and the state readers', () => {
    const app = createContainer()
    const remote = defineKey<Llm>('airi.llm.remote')
    const local = defineKey<{ chat: () => string, local: true }>('airi.llm.local')
    const context = createHookContext('stop')
    const decision = context.decide.fail(new Error('x'))

    // Design test 39: a decision carries the fields of its run.
    expectTypeOf(decision).toEqualTypeOf<FailDecision>()
    expectTypeOf(decision.service).toEqualTypeOf<string>()
    expectTypeOf(decision.instanceId).toEqualTypeOf<string>()
    expectTypeOf(decision.hook).toEqualTypeOf<ServiceHook>()
    expectTypeOf(decision.attempt).toEqualTypeOf<number>()
    expectTypeOf(decision.issuedAt).toEqualTypeOf<number>()
    expectTypeOf(context.decide.handled()).toEqualTypeOf<HandledDecision>()
    expectTypeOf<HandledDecision>().toExtend<Decision>()

    provide(app, 'voice.chat', {
      dependsOn: { llm: firstAvailable(remote, local), fallback: optional(firstAvailable(remote, local)) },
      build: ({ dependsOn }) => {
        expectTypeOf(dependsOn.llm).toEqualTypeOf<Llm | { chat: () => string, local: true }>()
        expectTypeOf(dependsOn.fallback).toEqualTypeOf<OptionalValue<Llm | { chat: () => string, local: true }> | undefined>()
        return dependsOn.llm.chat()
      },
    })

    expectTypeOf(watch(app, remote, (state) => {
      expectTypeOf(state).toEqualTypeOf<ServiceState>()
    })).toEqualTypeOf<() => void>()
    expectTypeOf(waitFor(app, 'airi.llm.remote', { status: 'ready' })).resolves.toEqualTypeOf<ServiceState>()
  })

  it('types where, replace, transactions, perConsumer, and the step 3 readers', () => {
    const app = createContainer()
    const llmKey = defineKey<Llm>('airi.llm', { exclusive: true })
    const llm = provide(app, llmKey, { metadata: { version: '1.0.0' }, build: () => ({ chat: () => 'hi' }) })

    provide(app, 'voice.speech', {
      dependsOn: { llm: where(llmKey, (provider) => {
        expectTypeOf(provider).toEqualTypeOf<ProviderInfo>()
        return provider.metadata.version === '1.0.0'
      }), tts: optional(where(defineKey<Tts>('airi.tts'), () => true)) },
      build: ({ dependsOn }) => {
        expectTypeOf(dependsOn.llm).toEqualTypeOf<Llm>()
        expectTypeOf(dependsOn.tts).toEqualTypeOf<OptionalValue<Tts> | undefined>()
        return 'speech'
      },
    })
    const localKey = defineKey<{ chat: () => string, local: true }>('airi.llm.local')
    provide(app, 'voice.fallback', {
      dependsOn: {
        outer: where(firstAvailable(llmKey, localKey), () => true),
        inner: firstAvailable(where(llmKey, () => true), localKey),
        optionalInner: optional(firstAvailable(where(llmKey, () => true), localKey)),
      },
      build: ({ dependsOn }) => {
        expectTypeOf(dependsOn.outer).toEqualTypeOf<Llm | { chat: () => string, local: true }>()
        expectTypeOf(dependsOn.inner).toEqualTypeOf<Llm | { chat: () => string, local: true }>()
        expectTypeOf(dependsOn.optionalInner).toEqualTypeOf<OptionalValue<Llm | { chat: () => string, local: true }> | undefined>()
        return 'fallback'
      },
    })
    provide(app, 'host.client', {
      perConsumer: true,
      build: ({ consumer }) => {
        expectTypeOf(consumer).toEqualTypeOf<OwnerRecord | undefined>()
        return consumer
      },
    })

    expectTypeOf(llm.replace(() => ({ chat: () => 'v2' }))).resolves.toEqualTypeOf<boolean>()
    expectTypeOf(llm.replace({ dependsOn: { other: 'airi.other' }, build: ({ dependsOn }) => ({ chat: () => String(dependsOn.other) }) })).resolves.toEqualTypeOf<boolean>()
    // @ts-expect-error A replacement must build the type of the key.
    void llm.replace(() => 42)

    const tx = transaction(app)
    expectTypeOf(tx.provide(defineKey<Tts>('airi.tts'), () => ({ speak: () => {} }))).toEqualTypeOf<Registration<string, Tts, undefined>>()
    // @ts-expect-error A transaction provide checks the type of the key too.
    transaction(app).provide(defineKey<Tts>('airi.tts.other'), () => 1)
    tx.replace(llm, () => ({ chat: () => 'v3' }))
    expectTypeOf(tx.commit()).resolves.toEqualTypeOf<void>()
    // A second commit rejects, so the check does not call it.
    expectTypeOf(tx.commit).toBeCallableWith({ signal: timeout(app, 1_000) })
    expectTypeOf(llm.replace(() => ({ chat: () => 'v4' }), { signal: withTimeout(undefined, 1_000, app) })).resolves.toEqualTypeOf<boolean>()
    // @ts-expect-error `timeoutMs` was removed. Pass a signal from `timeout(container, ms)`.
    void resolve(app, { llm }, { timeoutMs: 1_000 })

    expectTypeOf(graph(app).services()).toEqualTypeOf<readonly GraphService[]>()
    expectTypeOf(listeners<(event: string) => void>(app, { id: 'airi.event' })).toEqualTypeOf<readonly ListenerEntry<(event: string) => void>[]>()
  })
  it('types the retry and timeout options', () => {
    const app = createContainer({ maxAttempts: 5, timeouts: { start: 1_000, stop: 500 }, random: () => 0.5 })
    provide(app, 'airi.device', {
      maxAttempts: 3,
      timeouts: { start: 2_000 },
      onTimeout: (context) => {
        expectTypeOf(context.timeoutMs).toEqualTypeOf<number>()
        if (context.hook === 'start')
          return context.decide.requeue({ backoff: { kind: 'exponential', initial: 100, max: 1_000, jitter: 0.2 } })
        // @ts-expect-error A stop timeout cannot requeue.
        void context.decide.requeue
        return context.decide.handled()
      },
      build: () => 'device',
    })

    // @ts-expect-error A timeout is a number of milliseconds.
    const wrong: PolicyOptions = { timeouts: { start: '1s' } }
    void wrong
  })

  it('types the logging option, and enabled is gone', () => {
    const app = createContainer({ logging: true })
    expectTypeOf(app.logging).toEqualTypeOf<boolean>()

    // @ts-expect-error `enabled` was removed. Lifecycle logs are off by default. Pass `logging: true` to write them.
    void createContainer({ enabled: false })
  })
})
