---
name: injeca
description: >-
  Guide for using injeca 0.3, a pure functional dependency injection library for TypeScript with
  service lifecycles, run-time changes, status propagation, and child containers, inspired by
  go.uber.org/fx and go.uber.org/dig. Use this skill when the user imports from 'injeca', mentions
  injeca, wires services with start and stop hooks, manages startup and shutdown order, adds or
  withdraws or replaces services at run time, uses transactions, exclusive keys, or graph queries,
  configures start retries, hook timeouts, and AbortSignal cancellation, builds a plugin system on a container, or migrates
  from the injeca 0.2 `lifecycle` key. Also use it when the user asks about class-free alternatives to
  tsyringe, inversify, or awilix.
license: MIT
metadata:
  author: moeru-ai
  version: "0.3.0"
---

# injeca

Pure functional dependency injection with service lifecycles and run-time convergence. It works in Node.js, Electron, browsers, and workers.

## Core concepts

1. **No classes, no decorators.** Everything is plain functions and objects.
2. **One instance for each build.** `build` runs once for each instance. injeca caches the result.
3. **Lifecycle in `build`.** `on('start')` and `on('stop')` in the build context. Dependents stop before their providers.
4. **Convergence.** Services can appear, disappear, and change after `start()`. Dependents rebuild or move to the new instance.
5. **Status.** A running service is `ready`, `degraded`, or `unavailable`. The effective status goes down the graph.

## Global container

```ts
import { injeca } from 'injeca'

// provide returns a typed key for dependsOn.
const config = injeca.provide('config', () => ({ port: 3000 }))

const server = injeca.provide({
  dependsOn: { config },
  build({ dependsOn, on, effect, signal }) {
    const app = createServer()
    on('start', () => app.listen(dependsOn.config.port))
    on('stop', () => app.close())
    return app
  },
})

injeca.invoke({
  dependsOn: { server },
  callback({ server }) {
    console.info('Server ready:', server.address())
  },
})

await injeca.start()
process.once('SIGINT', () => injeca.stop())
```

## Containers

```ts
import { createContainer, dispose, invoke, provide, start, stop } from 'injeca'

const container = createContainer({ enabled: false }) // logging off, for tests

const token = provide(container, 'token', () => crypto.randomUUID())
invoke(container, { dependsOn: { token }, callback: ({ token }) => console.info(token) })

await start(container)
await stop(container) // stop keeps the registrations
await dispose(container) // dispose clears the container
```

A child container uses `createContainer({ parent, owner })`. It resolves keys from its ancestors and does not start until `start(child)` runs.

A child registration is invisible to the parent and to the siblings. `export: true` makes it a candidate in the area of the parent container too:

```ts
provide(pluginA, memoryKitKey, { export: true, build: () => createMemoryKit() }) // pluginB and the host can depend on it
```

- The registration stays in its container: owner, disposal, own dependencies, and phases. An export goes exactly one level up.
- At each level, the registration of that container comes before the exports of its children. An export shadows a farther ancestor only while it runs.
- `isolate: [key]` hides the exports of the siblings, but not the exports of the own children.
- `perConsumer` and `tx.provide` take `export` too. Consumer instances live in the consumer container. Their `dependsOn` resolves from the exporting container.

## Hooks and decisions

A hook gets a context with `decide`, `attempt`, `previous`, and `signal`. A return value that is not a decision, for example the result of `app.listen()`, selects the default of the hook. `decide` has only the methods that the hook allows:

| Hook | `decide` methods |
| --- | --- |
| `start` | `handled`, `requeue`, `stop`, `fail` |
| `stop` | `handled`, `fail` |
| `dependency-change`, `dependency-status-change` | all |

```ts
on('start', async ({ decide }) => {
  try {
    await app.listen(port)
  }
  catch (error) {
    return decide.fail(error)
  }
})
```

A dependency hook also gets `dependsOn` (the current snapshot) and `changes`. Decide from the current snapshot.

## Retries and timeouts

```ts
on('start', async ({ decide }) => {
  try {
    await device.connect()
  }
  catch {
    return decide.requeue({ backoff: { kind: 'exponential', initial: 500, max: 30_000, jitter: 0.2 }, maxAttempts: 5 })
  }
})

injeca.provide('modules:camera', {
  maxAttempts: 3, // the decision overrides it, and it overrides createContainer({ maxAttempts })
  timeouts: { start: 10_000, stop: 5_000 }, // overrides createContainer({ timeouts })
  onTimeout: context => context.hook === 'start' ? context.decide.requeue({ after: 1_000 }) : undefined, // a stop timeout counts as handled
  build: () => createCamera(),
})
```

- A `start` requeue keeps the instance. The service is `retrying` and not available. The next attempt runs the handler that requeued again, not `build`.
- `after` is a fixed delay. `backoff` doubles `initial` up to `max`. `jitter` (0 to 1) uses `createContainer({ random })`, so tests stay deterministic.
- injeca has no built-in delay, limit, or timeout. Without `maxAttempts`, retries continue. At the limit, the service stops, then goes to `failed`. `start()` or `replace()` moves it out.
- A withdrawn required dependency or `stop()` cancels the wait and stops the service.
- A timeout records a `timeout` record in `observe`, then `onTimeout` decides. Without it, a `start` timeout gives `fail` with `hook-timeout`.
- Without `onTimeout`, a `stop` timeout counts as `handled`. It ends a stuck cleanup with a `logger.warn` warning, and `stop()`, `dispose()`, and `withdraw()` resolve. Only `decide.fail()` from `onTimeout` fails them.
- A late failure of a callback that injeca stopped waiting for goes to `logger.warn`. It is not an unhandled rejection.
- At a `start` or `stop` timeout, the `signal` of the hook aborts with the `HookTimeoutError`.

## Cancellation

Each call that can wait takes `{ signal }`, a standard `AbortSignal`. There is no `timeoutMs` option. Make a timeout signal on the container clock with `timeout(container, ms)`, never with `AbortSignal.timeout()`:

```ts
import { dispose, resolve, start, timeout, withTimeout } from 'injeca'

await start(container, { signal: timeout(container, 10_000) }) // StartTimeoutError with explanations
const { llm } = await resolve(container, { llm: llmKey }, { signal: withTimeout(request.signal, 5_000, container) })
await registration.replace(next, { signal }) // false when the signal aborts before the swap
await tx.commit({ signal }) // aborts and rolls back before the publish
await registration.withdraw({ signal }) // the withdrawal continues after the abort
await dispose(container, { signal: timeout(container, 5_000) })
```

- A timeout reason has `name === 'TimeoutError'`. `resolve` and `waitFor` turn it into `WaitTimeoutError` (`wait-timeout`). `start` turns it into `StartTimeoutError` (`start-timeout`). Another reason rejects as it is.
- `start`, `stop`, `dispose`, and `withdraw` stop only the wait. The services keep converging, and the cleanups keep running. `stop`, `dispose`, and `withdraw` send a `wait-aborted` record for each service that did not stop.
- After an aborted `dispose`, the container stays in `disposing`. Call `dispose(container)` again to wait for the result.
- An aborted signal ends the call at once. A call removes its listener from the signal when it settles.
- Calling dispose from a cleanup: pass the cleanup `signal`, for example `on('stop', async ({ signal }) => { await dispose(container, { signal }) })`. injeca knows the instance of each signal of builds, hooks, and invocations, also through `withTimeout`. While the teardown of that instance runs, the call warns, sends a `reentrant-call` record, and resolves at once. There is no `reentrant-dispose` error.
- The same applies to `withdraw({ signal })` from a cleanup of the withdrawn service, or of a dependent that holds it. A re-entrant `withdraw()` resolves `true`.
- Tests: `manualClock()` and `drained(container)` from `injeca/testing` drive `timeout()` and policy timeouts without real time. Call `advance(ms)`, then await `drained(container)`.

## Run-time changes

```ts
const vision = injeca.provide('modules:vision', () => createVision())
await vision.withdraw() // dependents stop first. A stale registration returns false.
```

- Without a `dependency-change` handler, a dependent rebuilds when a dependency gets a new instance.
- A rebuild of a running service has no gap. The new instance builds and starts while the old one serves. Then they swap in one batch, and the dependents get `dependency-change`.
- A rebuild stops first only when a dependency of the old instance has no provider now. An invocation always stops first, then runs again. A failed new instance stops the old one and moves the service to `failed`.
- A withdrawn required dependency always stops the dependent.

### Replacement and transactions

```ts
import { transaction } from 'injeca'

const tts = injeca.provide(ttsKey, () => createTts())
await tts.replace(() => createTtsV2()) // no gap: the old instance serves until the new one completes start

const tx = transaction(container)
tx.declare(statusKitKey, { dependsOn: { character: characterKey } })
tx.provide(statusKitKey, { build: ({ dependsOn }) => createStatusKit(dependsOn) })
tx.provide(characterKey, () => createCharacter())
await tx.commit() // builds in dependency order, publishes in one batch, then runs the start hooks
```

- `replace()` resolves `true` after the swap, and `false` for a stale registration. A failed new instance keeps the old one. A service in `stopping` rejects with `replace-while-stopping`.
- While the swap waits, `explain(key).replacement` shows the new instance with its phase and blockers.
- A failed transaction build publishes nothing and runs no `start` hook. `tx.abort()` and a container disposal drop the transaction.

## Keys, optional, and fallback

```ts
import { defineKey, firstAvailable, optional } from 'injeca'

const llmKey = defineKey<LlmClient>('airi.llm') // no provider yet

injeca.provide('voice:speech', {
  dependsOn: { llm: firstAvailable(remoteLlmKey, llmKey), tts: optional(ttsKey) },
  build: ({ dependsOn }) => createSpeech(dependsOn.llm, dependsOn.tts?.value),
})

injeca.provide(llmKey, () => createLocalLlm()) // the build result must match LlmClient
```

- `defineKey(name, { exclusive: true })` allows one provider in a resolution area. Two providers both go to `conflict` and run no code. When one leaves, the other converges. An export counts in the area of the parent, so two sibling exports of one exclusive key conflict.
- `where(key, ({ key, owner, metadata }) => boolean)` accepts a provider only when the condition returns `true`. It must be pure and synchronous.
- `where(firstAvailable(a, b), condition)` filters each candidate. `firstAvailable(where(a, condition), b)` filters `a` only. The selection is the first available candidate that passes. `optional` combines in any order. `explain()` names each rejected candidate.
- `perConsumer: true` runs `build` once for each consumer container, with `consumer` in the build context. Its `dependsOn` resolves from the container of the registration. `metadata` is a frozen record that conditions and graph queries read.
- A required, an optional, or a `firstAvailable` edge to a `perConsumer` key demands the consumer instance, also when the key registers later.

## Status and reading state

```ts
import { observe, timeout, waitFor, watch } from 'injeca'

build: ({ setStatus }) => {
  setStatus('unavailable', { reason: 'reconnecting' })
}

watch(container, server, ({ phase, status }) => {})
await waitFor(container, server, { status: 'ready', signal: timeout(container, 5_000) })
observe(container, record => {})
```

## Graph queries

```ts
import { graph } from 'injeca'

const queries = graph(container)
queries.services()
queries.dependencies(server)
queries.dependents(config)
queries.order()
queries.cycles()
queries.explain(server) // why a service is not running, and its pending replacement
queries.impact({ kind: 'withdraw', key: llmKey }) // { stopped, rebuilt, notified }, on a copy of the graph
```

Graph queries are pure reads. Use `explain()` for diagnostics and `impact()` to preview an action.

## Reading without waiting

```ts
import { peek, resolve, timeout } from 'injeca'

const result = peek(container, llmKey) // never builds or waits
if (result.kind === 'resolved')
  use(result.value)
else
  console.info(result.kind) // missing, rejected, conflict, not-running, or unavailable

const { llm } = await resolve(container, { llm: llmKey }, { signal: timeout(container, 5_000) })
```

- `waitFor` rejects with `ServiceFailedError` (`service-failed`) when the service fails.
- `invoke()` returns `{ key, withdraw }`. Graph queries accept the key.

## Key rules

1. Use typed keys from `provide()` or `defineKey()` in `dependsOn`. Do not use `any`.
2. Put start and stop logic in `on('start')` and `on('stop')`. The `lifecycle` key of 0.2 does not exist.
3. A missing provider or a cycle keeps a service `pending`. `start()` waits. Use `start(container, { signal: timeout(container, ms) })` to fail with an explanation.
4. A cleanup that calls `stop()` or `dispose()` of its own container, or of an ancestor, or `withdraw()` of a registration that waits for it, passes its `signal`. Then the call warns and resolves at once. Without the signal, after an `await`, only a configured `stop` timeout ends the cleanup.
5. Code that keeps a dependency must be a service or an invocation, so that it converges. `resolve()` is for one-time code.
6. Use `replace()`, not `withdraw()` and `provide()`, to change a service without a gap.
7. Do not use `Math.random` or real timers in retry and timeout tests. Pass `random` and the `clock` of `manualClock()` from `injeca/testing` to `createContainer`. `timeout(container, ms)` uses that clock.

## Documentation

See the README and `docs/design-0.3.md` in `moeru-ai/injeca`.
