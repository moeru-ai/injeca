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
- `start(container, { timeoutMs })` rejects with a `StartTimeoutError` that explains each service that is not running. injeca has no built-in timeout.
- A service with a missing provider, or in a dependency cycle, stays `pending`. Use `timeoutMs` to find it.

## Reading state

```ts
import { observe, waitFor, watch } from 'injeca'

const container = injeca.getContainer()

const stopWatching = watch(container, server, ({ phase, status }) => {})
await waitFor(container, server, { status: 'ready', timeoutMs: 5_000 })
const stopObserving = observe(container, (record) => {})
```

- `watch` sends the current state at once, then each change, in order.
- `observe` sends each phase change, status change, and decision in the container and its children.

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
- `invoke()` returns a handle with `withdraw()`. Its callback runs again when a required dependency gets a new instance.

## Planned

Atomic replacement (`replace()`), transactions, exclusive keys, resolution conditions, graph queries, and `start` retries with backoff are not in this release yet. See [the 0.3 design](../../docs/design-0.3.md).

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
