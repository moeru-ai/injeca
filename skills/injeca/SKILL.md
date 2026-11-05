---
name: injeca
description: >-
  Guide for using injeca 0.3, a pure functional dependency injection library for TypeScript with
  service lifecycles, run-time changes, status propagation, and child containers, inspired by
  go.uber.org/fx and go.uber.org/dig. Use this skill when the user imports from 'injeca', mentions
  injeca, wires services with start and stop hooks, manages startup and shutdown order, adds or
  withdraws services at run time, builds a plugin system on a container, or migrates from the
  injeca 0.2 `lifecycle` key. Also use it when the user asks about class-free alternatives to
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

## Run-time changes

```ts
const vision = injeca.provide('modules:vision', () => createVision())
await vision.withdraw() // dependents stop first. A stale registration returns false.
```

- Without a `dependency-change` handler, a dependent rebuilds when a dependency gets a new instance.
- A withdrawn required dependency always stops the dependent.

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

## Status and reading state

```ts
import { observe, waitFor, watch } from 'injeca'

build: ({ setStatus }) => {
  setStatus('unavailable', { reason: 'reconnecting' })
}

watch(container, server, ({ phase, status }) => {})
await waitFor(container, server, { status: 'ready', timeoutMs: 5_000 })
observe(container, record => {})
```

## Key rules

1. Use typed keys from `provide()` or `defineKey()` in `dependsOn`. Do not use `any`.
2. Put start and stop logic in `on('start')` and `on('stop')`. The `lifecycle` key of 0.2 does not exist.
3. A missing provider or a cycle keeps a service `pending`. `start()` waits. Use `start({ timeoutMs })` to fail with an explanation.
4. A cleanup must not await the disposal of its own container.
5. Code that keeps a dependency must be a service or an invocation, so that it converges. `resolve()` is for one-time code.

## Documentation

See the README and `docs/design-0.3.md` in `moeru-ai/injeca`.
