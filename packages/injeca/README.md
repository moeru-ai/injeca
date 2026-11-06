# Injeca

Pure functional dependency injection for TypeScript, with service lifecycles, run-time changes, and status propagation. No classes, no decorators, and no extra wrappers.

> Heavily inspired by [uber/fx](https://go.uber.org/fx), [uber/fig](https://go.uber.org/fig), and [uber/dig](https://go.uber.org/dig) in the Go ecosystem.

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

## Installation

```sh
npm install injeca
pnpm add injeca
bun add injeca
ni injeca
yarn add injeca
```

injeca works in Node.js, Electron, browsers, and workers. It has no Node-only code.

### Agent Skills

Install the [injeca skill](https://skills.sh) to your AI coding agent:

```sh
npx skills add moeru-ai/injeca
```

## Basic usage

`injeca` ships with a global container exposed as `injeca`. Register services, declare their dependencies, and start.

```ts
import { createServer } from 'node:http'

import { injeca } from 'injeca'

// A service returns a value once. The container caches it.
const config = injeca.provide('config', () => ({ port: 3000 }))

const server = injeca.provide({
  dependsOn: { config },
  build({ dependsOn, on }) {
    const app = createServer()

    on('start', () => app.listen(dependsOn.config.port))
    on('stop', () => app.close())

    return app
  },
})

injeca.invoke({
  dependsOn: { server },
  callback({ server }) {
    console.info('HTTP server ready:', server.address())
  },
})

await injeca.start()

process.once('SIGINT', async () => {
  await injeca.stop()
})
```

- `provide` returns a typed key. Use it in `dependsOn`. injeca infers the type of each dependency.
- `start()` builds each service when its dependencies are running, then runs its `start` hooks. It resolves when everything is running.
- `stop()` stops dependents before their providers. The registrations stay, so a later `start()` builds them again.

> [!WARNING]
>
> **`injeca` caches each value that `build` returns.**
>
> `build` runs once for each instance. If `build` returns a function, injeca caches that function, not the result of a call. This is useful for lazy dependencies and getters. Side effects inside the returned function run on every call.
>
> To reuse one resource, for example a single window, create it once inside `build` and return a wrapper:
>
> ```ts
> const settingsWindow = injeca.provide('windows:settings', {
>   dependsOn: { widgetsManager },
>   build: ({ dependsOn }) => {
>     const getWindow = setupReusableSettingsWindow(dependsOn) // created once
>     return async () => await getWindow() // can be called many times
>   },
> })
> ```

## Lifecycle in `build`

The build context gives each service its own lifecycle:

| Field | Meaning |
| --- | --- |
| `dependsOn` | The resolved dependencies |
| `on('start', handler)` | Runs after the service is published and its dependencies run |
| `on('stop', handler)` | Runs before the service stops. Its dependencies are still available. |
| `effect(setup)` | Runs `setup` at once. The disposer that it returns runs when the instance is disposed, after the `stop` hooks. |
| `signal` | An `AbortSignal` that aborts when a newer target replaces this build, or when the container is disposed |
| `setStatus(status, reason?)` | Sets the status of the instance. See [Status](#status). |

A hook gets a hook context with a typed `decide`. A return value that is not a decision, for example the result of `app.listen()`, selects the default of the hook. Return a decision to tell injeca what to do next:

```ts
on('start', async ({ decide, attempt }) => {
  try {
    await app.listen(port)
  }
  catch (error) {
    return decide.fail(error)
  }
})
```

### Retries

A `start` hook can return `decide.requeue()` to try again later. The service keeps its instance, so `build` does not run again.

```ts
on('start', async ({ decide }) => {
  try {
    await device.connect()
  }
  catch (error) {
    return decide.requeue({
      backoff: { kind: 'exponential', initial: 500, max: 30_000, jitter: 0.2 },
      maxAttempts: 5,
      reason: `connect failed: ${String(error)}`,
    })
  }
})
```

- During the wait, the service is `retrying`. It is not available, so its dependents stay `pending`. It still holds its dependencies.
- `after: ms` sets a fixed delay. `backoff` doubles `initial` for each attempt, up to `max`. `jitter` is a fraction from 0 to 1 that takes a random part away from each delay.
- The next attempt runs the `start` handler that requeued, then the handlers after it.
- Changes during the wait merge into one attempt. A withdrawn required dependency, or `stop()`, cancels the wait and stops the service at once.
- A dependency hook can requeue too. The service stays `running` with its current dependencies during the wait.
- injeca has no built-in delay or limit. Without `maxAttempts`, the retries continue.

`maxAttempts` limits the runs of one hook for one instance. It can come from the decision, the `provide` options, or the container options. The decision wins over the service, and the service wins over the container. A child container uses the value of its nearest ancestor.

```ts
const container = createContainer({ maxAttempts: 10, random: () => 0.5 }) // a fixed random source for deterministic tests
injeca.provide('modules:device', { maxAttempts: 3, build: () => createDevice() })
```

When the attempts end, a running service stops first. Then it goes to `failed` with the last reason. `start()` again, `stop()` and `start()`, or `replace()` moves it out of `failed`.

### Timeouts

`start` and `stop` hooks wait until they settle. Set `timeouts` to limit them. A service value overrides the container value. injeca has no built-in timeout.

```ts
const container = createContainer({ timeouts: { stop: 5_000 } })

provide(container, 'modules:camera', {
  timeouts: { start: 10_000 },
  onTimeout: (context) => {
    if (context.hook === 'start')
      return context.decide.requeue({ after: 1_000, maxAttempts: 3 })
    return context.decide.fail(new Error('The camera did not close.'))
  },
  build: () => createCamera(),
})
```

- The `start` timeout is for all `start` handlers of one attempt. The `stop` timeout is for all `stop` handlers and effect disposers of one instance.
- When a timeout passes, `observe` gets a `timeout` record. Then `onTimeout` of the service, or of the container, decides. Without it, the result is `fail` with a `HookTimeoutError` (`hook-timeout`).
- `onTimeout` runs synchronously. `context.decide` has the methods of the hook that timed out.
- After a `stop` timeout, the remaining cleanups still run, but injeca does not wait for them. So a cleanup that awaits the disposal of its own container cannot block that disposal.
- With `createContainer({ asyncContext })`, such a cleanup gets a `ReentrantDisposeError` at once and needs no timeout. See [Containers](#containers).
- `stop()` and `dispose()` abort the signal of a `start` hook in progress and do not wait for it. The `stop` hooks run at once. A decision that the hook returns later is ignored.

## Changes at run time

Services can appear and disappear after `start()`. Dependents converge automatically.

```ts
await injeca.start()

// A provide after start() builds and starts when its dependencies run.
const vision = injeca.provide('modules:vision', {
  dependsOn: { config },
  build: ({ dependsOn }) => createVision(dependsOn.config),
})

// Withdraw. Dependents stop first. A stale registration returns false.
await vision.withdraw()
```

When a dependency gets a new instance, a dependent rebuilds by default. A `dependency-change` handler can move to the new instance in place:

```ts
on('dependency-change', ({ dependsOn, decide }) => {
  speech.setTts(dependsOn.tts?.value)
  return decide.handled()
})
```

A rebuild of a running service has no gap. The old instance keeps serving while a new instance builds and starts against the new dependencies. Then one batch swaps them, as for `replace()`. The dependents of the service get `dependency-change` with the new instance. They do not lose it.

- This applies to a rebuild without a handler and to `decide.rebuild()`.
- The service stops first and builds again when a dependency that the old instance uses has no provider now. Then there is nothing to build against.
- An invocation stops first and runs again.
- If the new instance fails, the old instance stops and the service goes to `failed`.
- A `replace()` during the rebuild cancels the rebuild and replaces the service.

### Atomic replacement

A withdrawal followed by a new `provide` leaves a gap: all dependents stop. `replace()` has no gap. A hot reload tool uses it.

```ts
const tts = injeca.provide(ttsKey, () => createTts())

// The old instance keeps serving while the new one runs `build` and `start`.
await tts.replace(() => createTtsV2())
```

- The swap is one batch. It occurs only after the new instance completes `start`. The new instance is `ready`.
- For a `perConsumer` registration, each running consumer gets a new instance first. The swap of all consumers is one batch, after each new instance completes `start`. If one fails, no consumer changes.
- If the new `build` or `start` fails, `replace()` rejects and the old instance does not change. This is also the usual fix for an `unavailable` provider.
- The old instance stops after each dependent releases it. A dependent with a `dependency-change` handler moves in place. Other dependents rebuild without a gap, so a replacement deep in the graph does not stop the services above it.
- `graph(container).explain(key)` shows the new instance as `replacement` while the swap waits, with its phase and blockers.
- A stale registration, or a call that a newer `replace()` or a withdrawal supersedes, resolves `false`. A service in `stopping` rejects with `ReplaceWhileStoppingError`.

### Transactions

A transaction publishes many services together, for example all exports of one plugin.

```ts
import { transaction } from 'injeca'

const tx = transaction(container)
tx.declare(statusKitKey, { dependsOn: { character: characterKey } })
tx.provide(statusKitKey, { build: ({ dependsOn }) => createStatusKit(dependsOn) })
tx.provide(characterKey, () => createCharacter())
await tx.commit()
```

- Nothing is visible to consumers before `commit()`. Graph queries show the declared services.
- `commit()` builds in dependency order. A service can use another service of the same transaction.
- If all builds succeed, the services publish in one batch, then their `start` hooks run. If one build fails, nothing publishes and `commit()` rejects.
- A service whose dependencies are not available goes to `pending`. That is not a failure.
- A declared service without `provide` fails the commit with `TransactionIncompleteError`, unless it is declared with `optional: true`.
- `tx.replace(key, option)` replaces a registration at the commit. `tx.abort()` and the disposal of the container drop everything.
- `tx.declare` and `tx.provide` reserve the key until the commit or the abort. Another `provide` of the key in the same container fails with `DuplicateServiceError`. For an exclusive key, a provider in another container of the area goes to `conflict` until the abort.
- `withdraw()` on the result of `tx.provide` before the commit removes that provide and resolves `true`. A declared key without a provide then fails the commit.

## Keys without a provider

`defineKey` creates a typed key. A consumer can depend on it before any provider exists. It stays `pending` and runs no code until a provider registers.

```ts
import { defineKey, firstAvailable, injeca, optional } from 'injeca'

export const llmKey = defineKey<LlmClient>('airi.llm')

injeca.provide('voice:speech', {
  dependsOn: {
    llm: firstAvailable(remoteLlmKey, llmKey), // the first available provider
    tts: optional(ttsKey), // `{ value, status } | undefined`
  },
  build: ({ dependsOn }) => createSpeech(dependsOn.llm, dependsOn.tts?.value),
})

// A plugin provides it later. The build result must match LlmClient.
injeca.provide(llmKey, () => createLocalLlm())
```

### Exclusive keys

An exclusive key can have only one provider in its resolution area: the container that has the key, with its descendants.

```ts
const whiteboardKey = defineKey<Whiteboard>('dev.airi.whiteboard', { exclusive: true })
```

If two containers in one area provide it, both go to `conflict`, in any order. They run no code, and their dependents stay `pending`. When one provider is removed, the other converges. `graph(container).explain()` lists the owner of each provider.

An [exported registration](#exported-registrations) counts in the area of the parent container. So two sibling plugins that export one exclusive key conflict, and so do a host registration and a plugin export of that key.

### Resolution conditions

`where(key, condition)` accepts a provider only when the condition returns `true`. The condition reads the key, the owner, and the `metadata` of the provider.

```ts
import { defineKey, optional, where } from 'injeca'

const panelKey = injeca.provide('whiteboard:panel', { metadata: { version: '2.1.0' }, build: () => createPanel() })
const themeKey = defineKey<Theme>('ui:theme')

injeca.provide('whiteboard:view', {
  dependsOn: {
    panel: where(panelKey, ({ metadata }) => String(metadata.version).startsWith('2.')),
    theme: optional(where(themeKey, ({ owner }) => owner.kind === 'host')),
  },
  build: ({ dependsOn }) => createView(dependsOn.panel, dependsOn.theme?.value),
})
```

- A rejected required dependency keeps the dependent `pending`. A rejected optional dependency is `undefined`.
- The condition must be pure and synchronous. A thrown error counts as `false` and goes to the observe stream.

A condition also filters the candidates of `firstAvailable`. The selection is the first available candidate that passes:

```ts
import type { ProviderInfo } from 'injeca'

import { firstAvailable, optional, where } from 'injeca'

const atLeastTwo = ({ metadata }: ProviderInfo) => String(metadata.version).startsWith('2.')

injeca.provide('voice:chat', {
  dependsOn: {
    // The condition applies to each candidate.
    llm: where(firstAvailable(remoteLlmKey, localLlmKey), atLeastTwo),
    // The condition applies to the remote candidate only.
    backup: optional(firstAvailable(where(remoteLlmKey, atLeastTwo), localLlmKey)),
  },
  build: ({ dependsOn }) => createChat(dependsOn.llm, dependsOn.backup?.value),
})
```

- `where`, `firstAvailable`, and `optional` combine in any order. A candidate with two conditions must pass both.
- `graph(container).explain()` names each candidate that a condition rejected.

## Status

A running service is `ready`, `degraded`, or `unavailable`.

- `degraded` means that calls still complete, at lower quality.
- `unavailable` means that the instance exists, but calls fail now.
- The effective status of a service is the worst of its own status and the effective status of each required dependency. It goes down the graph.
- A dependency that becomes `unavailable` does not stop or rebuild its dependents. They get a `dependency-status-change` call if they register a handler.

```ts
build: ({ setStatus }) => {
  const client = connect()
  client.on('reconnecting', () => setStatus('unavailable', { reason: 'reconnecting' }))
  client.on('ready', () => setStatus('ready'))
  return client
}
```

## Containers

Create containers to isolate tests, or to give each plugin its own child container.

```ts
import { createContainer, dispose, effect, invoke, provide, start, stop } from 'injeca'

const container = createContainer()

const token = provide(container, 'token', () => crypto.randomUUID())

invoke(container, {
  dependsOn: { token },
  callback: ({ token }) => console.info('token', token),
})

await start(container)
await stop(container)
```

A child container resolves keys from its ancestors. It does not start until `start(child)` runs, so a caller can register all its services first.

```ts
const plugin = createContainer({
  parent: injeca.getContainer(),
  owner: { kind: 'plugin', id: 'agent-activity' },
})

provide(plugin, 'agent-activity:reaction', { dependsOn: { llm: llmKey }, build: () => createReaction() })
effect(plugin, () => () => console.info('plugin cleaned up'))

await start(plugin, { timeoutMs: 10_000 })
await dispose(plugin)
```

- `stop()` stops. `dispose()` also withdraws the registrations and runs the container effects. A disposed container cannot be used again.
- `dispose(parent)` disposes the child containers first, newest first, each one with its effects. Then the services of the parent stop, and then its effects run.
- `effect(container, setup)` after the disposal started runs the disposer at once.
- `start(container, { timeoutMs })` rejects with a `StartTimeoutError` that explains each service that is not running. injeca has no built-in timeout.
- A service with a missing provider, or in a dependency cycle, stays `pending`. Use `timeoutMs` to find it.
- A provider in a child container shadows the provider of an ancestor only while it is `running`. Until then, and after it stops, dependents use the ancestor provider. So shadowing never leaves a gap.
- `createContainer({ isolate: [key] })` stops a key from resolving from the ancestors. It also hides the exports of the sibling containers. It does not hide the exports of its own child containers.
- A dispose call from the synchronous part of a cleanup of the same container, or of a descendant, rejects with `ReentrantDisposeError` (`reentrant-dispose`). After an `await`, injeca detects it only with an `asyncContext`.

### Async context

injeca imports no runtime module. To detect a cleanup that awaits the disposal of its own container after an `await`, give the root container an async context. In Node, use `AsyncLocalStorage`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<unknown>()
const host = createContainer({
  asyncContext: { run: (store, fn) => storage.run(store, fn), get: () => storage.getStore() },
})
```

- Only a root container reads `asyncContext`. Its child containers use it too.
- Without it, a cleanup that awaits its own disposal waits until a `stop` timeout ends it.

### Exported registrations

A registration in a child container is visible only in that container and its descendants. `export: true` also makes it a candidate for consumers in the area of the parent container: the parent and each of its descendants. So a plugin can use a Kit that another plugin provides.

```ts
const host = createContainer({ owner: { kind: 'host' } })
const pluginA = createContainer({ parent: host, owner: { kind: 'plugin', id: 'a' } })
const pluginB = createContainer({ parent: host, owner: { kind: 'plugin', id: 'b' } })

provide(pluginA, memoryKitKey, { export: true, build: () => createMemoryKit() })
provide(pluginB, 'b:session', { dependsOn: { memory: memoryKitKey }, build: ({ dependsOn }) => startSession(dependsOn.memory) })
```

- The registration stays in its container. That container owns it, and `dispose(pluginA)` withdraws it. Its own dependencies resolve from that container. This is also true for a `perConsumer` export.
- An export goes exactly one level up. A container that wants to reach the area of its grandparent exports from its own level.
- A consumer looks in its own container, then in each ancestor. At each level, the registration of that container comes first, then the exports of its children in creation order.
- Shadowing still has no gap. An export takes over from a provider of a farther ancestor only while it runs.
- `perConsumer` and `export` combine. Each consumer instance lives in the consumer container.
- `tx.provide(key, { export: true, ... })` reserves an exclusive key in the parent area at once, and the commit publishes the service there in one batch.
- `replace()` keeps the export. On a root container, `export` has no effect.
- `graph(parent)`, `peek`, `watch`, `waitFor`, and `observe` see the export. `graph().services()` marks it with `exported: true`, and its `owner` is the owner of the exporting container.

### Per-consumer services

`perConsumer: true` runs `build` once for each consumer container. The build context has `consumer`, the owner record of that container. The instance disposes with the consumer container.

The instance lives in the consumer container, but its `dependsOn` resolves from the container of the registration, as for a plain registration. So a key of the consumer container does not change the dependencies of the registration.

A dependent demands its consumer instance through a required, an optional, or a `firstAvailable` edge. This is also true when the key registers after the dependent.

A failed consumer instance builds again on the next demand from its container: a new `resolve`, `watch`, or `waitFor` call, or a dependent that starts to wait. Each demander gets one new build for each failure.

```ts
const hostClient = injeca.provide('host:client', {
  perConsumer: true,
  metadata: { api: 'v1' },
  build: ({ consumer }) => createHostClient(consumer),
})
```

`metadata` is a frozen record on any registration. Resolution conditions and graph queries read it.

## Reading state

```ts
import { observe, waitFor, watch } from 'injeca'

const container = injeca.getContainer()

const stopWatching = watch(container, server, ({ phase, status }) => {})
await waitFor(container, server, { status: 'ready', timeoutMs: 5_000 })
const stopObserving = observe(container, (record) => {})
```

- `watch` sends the current state at once, then each change, in order.
- `waitFor` rejects with a `ServiceFailedError` (`service-failed`) when the service failed, or waits for a required provider that failed. Its `cause` is the failure.
- For a `perConsumer` key, `watch` and `waitFor` create the consumer instance for their container, as `resolve` does. The demand ends with the subscription.
- `observe` sends each phase change, status change, decision, and hook timeout in the container and its children.

`peek` reads a value now, without a wait, and never builds anything. `resolve` takes `signal` and `timeoutMs` to stop a wait:

```ts
import { peek, resolve, where } from 'injeca'

const result = peek(container, where(llmKey, ({ metadata }) => metadata.version === '2'))
if (result.kind === 'resolved')
  result.value.chat()
else
  console.info(result.kind) // 'missing', 'rejected', 'conflict', 'not-running', or 'unavailable'

const { llm } = await resolve(container, { llm: llmKey }, { timeoutMs: 5_000 }) // rejects with WaitTimeoutError
```

### Graph queries

`graph(container)` reads the graph of the container and its children. It never changes state.

```ts
import { graph } from 'injeca'

const queries = graph(container)

queries.services() // all services, with the declared services of open transactions
queries.dependencies(server) // the direct edges of a service
queries.dependents(config) // the services that use a service now
queries.order() // providers before their dependents
queries.cycles() // each dependency cycle
queries.explain(server) // why a service is not running, also for a key without a provider, with a pending replacement
queries.impact({ kind: 'withdraw', key: llmKey }) // { stopped, rebuilt, notified }
```

`impact()` runs on a copy of the graph, so a user interface can preview an action: "Disabling the plugin also stops X and Y." The change can be `withdraw`, `replace`, or `dispose`.

### Listener registry

injeca does not dispatch events. It stores listeners that a container owns, so that a consumer can run them by its own rules.

```ts
import { listen, listeners } from 'injeca'

const gate = { id: 'airi.harness.gate' } // any object with a string id, for example an eventa definition

const remove = listen(plugin, gate, handler, { priority: 10 })
const entries = listeners(container, gate) // [{ handler, owner, metadata }]
```

`listeners()` returns the listeners of the container and its children, in registration order. `dispose(container)` removes the listeners of the container.

## Migration from 0.2

0.3 keeps the 0.2 call style: `provide`, `invoke`, `resolve`, `start`, `stop`, `createContainer`, and the global `injeca` object. One API changed:

```ts
// 0.2
const server = injeca.provide({
  dependsOn: { lifecycle },
  build({ dependsOn }) {
    const app = createServer()
    dependsOn.lifecycle.appHooks.onStart(() => app.listen(3000))
    dependsOn.lifecycle.appHooks.onStop(() => app.close())
    return app
  },
})

// 0.3
const server = injeca.provide({
  build({ on }) {
    const app = createServer()
    on('start', () => app.listen(3000))
    on('stop', () => app.close())
    return app
  },
})
```

Other differences:

- `start()` waits for a missing provider. 0.2 threw an error. Use `start({ timeoutMs })` to fail after a time.
- `resolve()` waits for a missing provider too. Before `start()`, it builds the services that it needs, with their `start` hooks.
- `invoke()` returns a handle with `key` and `withdraw()`. Graph queries accept `key`. Its callback runs again when a required dependency gets a new instance.

## License

MIT

[npm-version-src]: https://img.shields.io/npm/v/injeca?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/injeca
[npm-downloads-src]: https://img.shields.io/npm/dm/injeca?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/injeca
[bundle-src]: https://img.shields.io/bundlephobia/minzip/injeca?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=injeca
[license-src]: https://img.shields.io/github/license/moeru-ai/injeca.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/moeru-ai/injeca/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/injeca
