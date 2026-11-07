<!-- Generated from README.md of the repository by `pnpm docs:update`. Edit README.md instead. -->

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/hero-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/hero-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="injeca: ask for what you want, and injeca finds what it needs and builds it. Twelve units wait in the registry. resolve() asks for window, tray, speech, and chat, and a map of the graph walks back from that call to the eight units it needs, in two batches. Each batch builds at once, and the eight pieces lock together into one cube: that whole is app. The four units that it does not need stay pending in the registry." src="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/hero-light.webp" />
</picture>

# injeca

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

Pure functional dependency injection for TypeScript. Units declare their dependencies, own their lifecycle, and converge when the graph changes at run time. No classes, no decorators, and no extra wrappers.

> Heavily inspired by [uber/fx](https://go.uber.org/fx), [uber/fig](https://go.uber.org/fig), and [uber/dig](https://go.uber.org/dig) in the Go ecosystem, and by the run-time model of [Cordis](https://github.com/cordiverse/cordis).

**[Open the scenario lab](https://injeca.moeru.ai/)** to see what each primitive does to a graph. The lab runs injeca in the page and steps through each scenario, so every frame shows real behavior. Its sandbox lets you replace, withdraw, and set the status of units yourself, with a preview from `graph().impact()`. The lab is in English and Simplified Chinese ([简体中文](https://injeca.moeru.ai/?lang=zh-Hans)).

## Getting started

```sh
npm install injeca
pnpm add injeca
bun add injeca
ni injeca
yarn add injeca
```

injeca works in Node.js, Electron, browsers, and workers. It has no Node-only code.

Register two units, start, and ask for one:

```ts
import { injeca } from 'injeca'

const config = injeca.provide('config', () => ({ name: 'injeca' }))

const greeter = injeca.provide('greeter', {
  dependsOn: { config },
  build: ({ dependsOn }) => {
    return (who: string) => `Hello ${who}, from ${dependsOn.config.name}`
  },
})

await injeca.start()

const { greeter: greet } = await injeca.resolve({ greeter })
console.info(greet('world')) // Hello world, from injeca

await injeca.stop()
```

- `provide` returns a typed key, and `dependsOn` takes keys. `greeter` gets `config` without an import of its value.
- `start()` builds `config` first, then `greeter`. `stop()` stops them in reverse.

Next, read [Basic usage](#basic-usage) for hooks and the lifecycle, or open [the scenario lab](https://injeca.moeru.ai/) to watch each primitive work.

### Agent Skills

Install the [injeca skill](https://skills.sh) to your AI coding agent:

```sh
npx skills add moeru-ai/injeca
```

## What injeca handles

| You need to | Use | Read | Try |
| --- | --- | --- | --- |
| Wire units with typed keys, without classes or decorators | `provide`, `dependsOn`, `invoke` | [Basic usage](#basic-usage) | |
| Start and stop a resource with its unit, in dependency order | `on('start')`, `on('stop')`, `effect` | [Lifecycle in `build`](#lifecycle-in-build) | |
| Try a start again later | `decide.requeue()`, `maxAttempts` | [Retries](#retries) | [Lab][lab-retry] |
| Limit how long a hook can take | `timeouts`, `onTimeout` | [Timeouts](#timeouts) | |
| Stop waiting for any call | `{ signal }`, `timeout()`, `withTimeout()` | [Cancellation](#cancellation) | |
| Add and remove units after `start()` | `provide`, `withdraw()` | [Changes at run time](#changes-at-run-time) | |
| Take a new dependency in place, without a rebuild | `on('dependency-change')` | [Changes at run time](#changes-at-run-time) | [Lab][lab-handler] |
| Swap a running unit without a gap, for example for hot reload | `replace()` | [Atomic replacement](#atomic-replacement) | [Lab][lab-swap] |
| Publish many units all or nothing, for example a plugin | `transaction()` | [Transactions](#transactions) | [Lab][lab-plugin] |
| Depend on a key that a plugin provides later | `defineKey()` | [Keys without a provider](#keys-without-a-provider) | [Lab][lab-late] |
| Work with or without a dependency, or fall back to another provider | `optional()`, `firstAvailable()` | [Keys without a provider](#keys-without-a-provider) | [Lab][lab-late] |
| Allow only one provider of a key | `defineKey(name, { exclusive: true })` | [Exclusive keys](#exclusive-keys) | [Lab][lab-exclusive] |
| Accept only some providers, for example by version | `where()` | [Resolution conditions](#resolution-conditions) | |
| Report a connection that drops and comes back | `setStatus()` | [Status](#status) | [Lab][lab-status] |
| Give a plugin its own scope, and remove all of it at once | `createContainer({ parent })`, `dispose()` | [Containers](#containers) | [Lab][lab-containers] |
| Share a plugin unit with other plugins | `visibility: 'parent'` | [Visibility to the parent container](#visibility-to-the-parent-container) | |
| Build one instance for each consumer container | `instances: 'per-container'` | [Per-container instances](#per-container-instances) | |
| Watch the state of a unit, or wait for it | `watch()`, `waitFor()`, `observe()`, `peek()` | [Reading state](#reading-state) | |
| Explain why a unit does not run, or preview a change | `graph().explain()`, `graph().impact()` | [Graph queries](#graph-queries) | |
| Test timeouts and retries without real time | `manualClock()`, `drained()` | [Testing with a manual clock](#testing-with-a-manual-clock) | |

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
## Table of Contents

- [Basic usage](#basic-usage)
  - [How a unit moves](#how-a-unit-moves)
- [Lifecycle in `build`](#lifecycle-in-build)
  - [Retries](#retries)
  - [Timeouts](#timeouts)
- [Cancellation](#cancellation)
  - [Calling dispose from a cleanup](#calling-dispose-from-a-cleanup)
  - [Testing with a manual clock](#testing-with-a-manual-clock)
- [Changes at run time](#changes-at-run-time)
  - [Atomic replacement](#atomic-replacement)
  - [Transactions](#transactions)
- [Keys without a provider](#keys-without-a-provider)
  - [Exclusive keys](#exclusive-keys)
  - [Resolution conditions](#resolution-conditions)
- [Status](#status)
- [Containers](#containers)
  - [Logging](#logging)
  - [Visibility to the parent container](#visibility-to-the-parent-container)
  - [Per-container instances](#per-container-instances)
- [Reading state](#reading-state)
  - [Graph queries](#graph-queries)
  - [Listener registry](#listener-registry)
- [Packages](#packages)
- [Migration from 0.2](#migration-from-02)
- [Migration from 0.3 to 0.4](#migration-from-03-to-04)
- [Migration from 0.4 to 0.5](#migration-from-04-to-05)
  - [Service is now unit](#service-is-now-unit)
  - [An aborted replace() rejects](#an-aborted-replace-rejects)
- [Documentation automation](#documentation-automation)
- [Development](#development)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Basic usage

`injeca` ships with a global container exposed as `injeca`. Register units, declare their dependencies, and start.

```ts
import { createServer } from 'node:http'

import { injeca } from 'injeca'

// A unit returns a value once. The container caches it.
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
- `start()` builds each unit when its dependencies are running, then runs its `start` hooks. It resolves when everything is running.
- `stop()` stops dependents before their providers. The registrations stay, so a later `start()` builds them again.
- injeca writes no lifecycle logs by default. It writes warnings with `console.warn`. See [Logging](#logging).

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

### How a unit moves

Each unit has a phase. A unit runs no code until its required dependencies run.

```text
           ┌──────────── conflict ◄───────────┐
           ▼                                   │
declared → pending → building → starting → running
                         │          │  ▲        │
                         │          ▼  │        │
                         │       retrying       │
                         ▼          ▼           ▼
                       failed ◄── stopping ◄────┘
                                    │
                                    ▼
                                withdrawn
```

| Phase | Meaning |
| --- | --- |
| `declared` | A [transaction](#transactions) reserved the unit. Consumers cannot resolve it. |
| `pending` | The unit waits for its required dependencies. It runs no code. |
| `conflict` | An [exclusive key](#exclusive-keys) has more than one provider. It runs no code. |
| `building` | `build` runs. The instance is not visible. |
| `starting` | The instance is published. The `start` hooks run. |
| `retrying` | A `start` hook returned `requeue`. The unit waits for the next attempt. |
| `running` | The instance serves calls. Only this phase has a [status](#status). |
| `stopping` | The unit waits until its dependents release it. Then the `stop` hooks and the effect disposers run. |
| `failed` | A build failed, the retries ended, or a hook returned `fail`. |
| `withdrawn` | The registration is withdrawn and the instance is disposed. |

## Lifecycle in `build`

The build context gives each unit its own lifecycle:

| Field | Meaning |
| --- | --- |
| `dependsOn` | The resolved dependencies |
| `on('start', handler)` | Runs after the unit is published and its dependencies run |
| `on('stop', handler)` | Runs before the unit stops. Its dependencies are still available. |
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

A `start` hook can return `decide.requeue()` to try again later. The unit keeps its instance, so `build` does not run again.

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-retry-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-retry-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="A start hook fails. With decide.fail(), device goes to failed, and monitor and app wait. With decide.requeue(), device waits in retrying with its instance. With requeue and maxAttempts 2, the second failure ends the retries and device goes to failed." src="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-retry-light.webp" />
</picture>

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

- During the wait, the unit is `retrying`. It is not available, so its dependents stay `pending`. It still holds its dependencies.
- `after: ms` sets a fixed delay. `backoff` doubles `initial` for each attempt, up to `max`. `jitter` is a fraction from 0 to 1 that takes a random part away from each delay.
- The next attempt runs the `start` handler that requeued, then the handlers after it.
- Changes during the wait merge into one attempt. A withdrawn required dependency, or `stop()`, cancels the wait and stops the unit at once.
- A dependency hook can requeue too. The unit stays `running` with its current dependencies during the wait.
- injeca has no built-in delay or limit. Without `maxAttempts`, the retries continue.

`maxAttempts` limits the runs of one hook for one instance. It can come from the decision, the `provide` options, or the container options. The decision wins over the unit, and the unit wins over the container. A child container uses the value of its nearest ancestor.

```ts
const container = createContainer({ maxAttempts: 10, random: () => 0.5 }) // a fixed random source for deterministic tests
injeca.provide('modules:device', { maxAttempts: 3, build: () => createDevice() })
```

When the attempts end, a running unit stops first. Then it goes to `failed` with the last reason. `start()` again, `stop()` and `start()`, or `replace()` moves it out of `failed`.

### Timeouts

`start` and `stop` hooks wait until they settle. Set `timeouts` to limit them. A unit value overrides the container value. injeca has no built-in timeout.

```ts
const container = createContainer({ timeouts: { stop: 5_000 } })

provide(container, 'modules:camera', {
  timeouts: { start: 10_000 },
  onTimeout: (context) => {
    if (context.hook === 'start')
      return context.decide.requeue({ after: 1_000, maxAttempts: 3 })
    return undefined // a stop timeout counts as handled
  },
  build: () => createCamera(),
})
```

- The `start` timeout is for all `start` handlers of one attempt. The `stop` timeout is for all `stop` handlers and effect disposers of one instance.
- When a timeout passes, `observe` gets a `timeout` record. Then `onTimeout` of the unit, or of the container, decides.
- Without `onTimeout`, a `start` timeout gives `fail` with a `HookTimeoutError` (`hook-timeout`).
- Without `onTimeout`, a `stop` timeout counts as `handled`. injeca writes a warning with `logger.warn`, and `stop()`, `dispose()`, and `withdraw()` resolve as usual. Only `decide.fail()` from `onTimeout` fails them.
- During a stop or a disposal of the container, the warning tells that a cleanup can be waiting for its own container. Then that cleanup must pass its signal. See [Calling dispose from a cleanup](#calling-dispose-from-a-cleanup).
- `onTimeout` runs synchronously. `context.decide` has the methods of the hook that timed out.
- After a `stop` timeout, the remaining cleanups still run, but injeca does not wait for them. So a cleanup that awaits the disposal of its own container without its signal cannot block that disposal.
- A cleanup or a `start` hook that injeca stopped waiting for can still fail later. injeca writes that failure with `logger.warn`, and a late `stop` decision gets a `decision` record with `ignored: true`. A rejection with the abort reason of the callback signal has no warning, because the callback only followed its abort.
- `stop()` and `dispose()` abort the signal of a `start` hook in progress and do not wait for it. The `stop` hooks run at once. A decision that the hook returns later is ignored.
- At a `start` timeout, the `signal` of the hook aborts with the `HookTimeoutError`. A `stop` handler sees the `stop` timeout on its `signal` in the same way.

## Cancellation

Each call that can wait takes `{ signal }`, a standard `AbortSignal`. injeca has no built-in timeout for these calls. Use `timeout(container, ms)` to make a signal on the container clock:

```ts
import { resolve, start, stop, timeout, withTimeout } from 'injeca'

await start(container, { signal: timeout(container, 10_000) })
const { llm } = await resolve(container, { llm: llmKey }, { signal: withTimeout(request.signal, 5_000, container) })
await stop(container, { signal: timeout(container, 5_000) })
```

- `timeout(container, ms)` aborts after `ms` on the clock of the container, with a `DOMException` named `TimeoutError`. Tests with a manual clock control it. `AbortSignal.timeout()` does not use the container clock.
- `withTimeout(signal, ms, container)` aborts when `signal` aborts, or after `ms`. `signal` can be `undefined`.
- An aborted signal ends the call at once. A call removes its listener from the signal when it settles.
- A timeout reason is a reason with `name === 'TimeoutError'`, from `timeout()` or from `AbortSignal.timeout()`.

| Call | When the signal aborts |
| --- | --- |
| `resolve(container, deps, { signal })` | Rejects. A timeout reason gives `WaitTimeoutError` (`wait-timeout`) with the reason as `cause`. Another reason rejects as it is. The hidden resolver goes. |
| `waitFor(container, key, { status, signal })` | The same as `resolve`. |
| `start(container, { signal })` | Stops the wait only. The units keep converging. A timeout reason gives `StartTimeoutError` (`start-timeout`) with the explanations. Another reason rejects as it is. |
| `stop(container, { signal })` | Rejects with the reason. The container is stopped, and a later `start()` builds again. The units that did not stop stay in `stopping` until their cleanups settle. |
| `dispose(container, { signal })` | Rejects with the reason. The disposal continues in the background, and the container stays in `disposing`. A later `dispose(container)` waits for the same disposal and gets its result. |
| `registration.withdraw({ signal })` | Rejects with the reason. The withdrawal continues. The unit gets a `wait-aborted` record when it did not finish. `invoke()` handles take the same option. |
| `registration.replace(option, { signal })` | Cancels a pending replacement, as a newer `replace()` does. The old instance stays, and `replace()` rejects. A timeout reason gives `WaitTimeoutError` (`wait-timeout`). Its message tells what the new instance waits for. Another reason rejects as it is. An aborted signal rejects at once and changes nothing. After the swap, the abort has no effect. |
| `tx.commit({ signal })` | Before the publish, the transaction aborts and rolls back, and `commit()` rejects at once with the reason. A `tx.replace` keeps the old instance. After the publish, the abort has no effect. The commit does not wait for the swap of a `tx.replace`. |

- For `stop`, `dispose`, and `withdraw`, each unit that did not stop gets a `wait-aborted` record in `observe`, with the phase at the abort and the reason.
- `replace` and `tx.commit` send no `wait-aborted` record. Their abort cancels the work, so no work continues without a waiter. The new instance leaves with its usual phase records.
- `resolve`, `waitFor`, `start`, and `replace` turn a timeout reason into a typed error, because they wait for a state. The error tells which state did not come.
- For `start`, `stop`, `dispose`, and `withdraw`, an aborted signal still starts the action. Only the wait ends.

### Calling dispose from a cleanup

A cleanup that awaits `stop()` or `dispose()` of its own container, or of an ancestor, waits for itself. A cleanup that awaits `withdraw()` of its own registration, or of a provider that it holds, waits for itself too. So does a cleanup that awaits `stop()` or `dispose()` of a container whose unit it holds. Pass the `signal` of the cleanup, so that injeca knows the caller:

```ts
provide(plugin, 'plugin:window', ({ on }) => {
  on('stop', async ({ signal }) => {
    await window.close()
    await dispose(plugin, { signal }) // resolves at once, and the disposal continues
  })
  return createWindow()
})
```

- injeca knows the instance of each signal that it gives to a build, a hook, and an invocation. A signal from `withTimeout(signal, ms, container)` keeps that origin. A signal from `AbortSignal.any()` does not.
- A call with such a signal while the teardown of its instance runs does not wait. The check uses the instance, so it also works during a rebuild or a replacement, when the old and the new instance live together. A signal of the new running instance still waits.
- The cleanup can also be outside the container. A unit of the parent that holds a parent-visible unit of a plugin container, directly or through other units, stops before that unit. So its `stop` hook can call `dispose(plugin, { signal })` or `stop(plugin, { signal })`, and the call does not wait. A plugin host that stops a plugin from its own cleanup needs this.
- A call from the synchronous part of a cleanup does not wait either.
- Such a call writes a warning with `logger.warn`, sends a `reentrant-call` record to `observe`, and resolves at once. A re-entrant `withdraw()` resolves `true`. The stop, the disposal, or the withdrawal continues. Other callers get a promise that settles when it ends.
- A call without a signal after an `await` is not found. It waits for itself until a configured `stop` timeout ends the cleanup. The warning of that timeout tells about this cause.

```ts
provide(plugin, 'plugin:host', ({ on }) => {
  on('stop', async ({ signal }) => {
    await sharedTool.withdraw({ signal }) // waits for the parent-visible unit, or resolves at once when it is re-entrant
    await dispose(plugin, { signal })
  })
  return createHost()
})
```

### Testing with a manual clock

`injeca/testing` has a manual clock, so that a test controls `timeout()`, `withTimeout()`, requeue delays, and policy timeouts without real time:

```ts
import { createContainer, provide, start, stop } from 'injeca'
import { drained, manualClock } from 'injeca/testing'

const { clock, advance } = manualClock()
const container = createContainer({ clock, timeouts: { stop: 1_000 } })
provide(container, 'modules:tray', ({ on }) => {
  on('stop', () => new Promise(() => {})) // never settles
  return createTray()
})

await start(container)
const stopped = stop(container)
await drained(container) // the work queue stays drained
advance(1_000) // runs the stop timeout, synchronously
await stopped // resolves, with a warning
```

- `advance(ms)` moves the time and runs each due timer in time order. `pending()` counts the timers that wait.
- `drained(container)` waits one real macrotask after each drain of the work queue. Do not use it while the fake timers of the test runner hold `setTimeout`.
- `createHookContext` and `checkDecision` test a hook handler alone.

The [scenario lab](https://injeca.moeru.ai/) uses the same two functions to step through each scenario.

## Changes at run time

Units can appear and disappear after `start()`. Dependents converge automatically.

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

| Change | No handler | With a `dependency-change` handler |
| --- | --- | --- |
| A required dependency is replaced | Rebuild without a gap | Call the handler |
| A required dependency is withdrawn | Stop | Stop. The handler gets a notice only. |
| An optional dependency appears, goes, or is replaced | Rebuild | Call the handler |
| The status of a dependency changes | Nothing | `dependency-status-change` gets a call, if it has a handler |

A rebuild of a running unit has no gap. The old instance keeps serving while a new instance builds and starts against the new dependencies. Then one batch swaps them, as for `replace()`. The dependents of the unit get `dependency-change` with the new instance. They do not lose it.

- This applies to a rebuild without a handler and to `decide.rebuild()`.
- The unit stops first and builds again when a dependency that the old instance uses has no provider now. Then there is nothing to build against.
- An invocation stops first and runs again.
- If the new instance fails, the old instance stops and the unit goes to `failed`.
- A `replace()` during the rebuild cancels the rebuild and replaces the unit.

### Atomic replacement

A withdrawal followed by a new `provide` leaves a gap: all dependents stop. `replace()` has no gap. A hot reload tool uses it.

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-swap-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-swap-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="Swap a provider while it runs. withdraw() and provide() leave a gap: speech and app wait in pending. replace() has no gap: tts v1 serves while tts v2 builds. replace() with a dependency-change handler: speech takes tts v2 in its own instance, and app does not change." src="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-swap-light.webp" />
</picture>

```ts
const tts = injeca.provide(ttsKey, () => createTts())

// The old instance keeps serving while the new one runs `build` and `start`.
await tts.replace(() => createTtsV2())
```

- The swap is one batch. It occurs only after the new instance completes `start`. The new instance is `ready`.
- For a per-container registration, each running consumer gets a new instance first. The swap of all consumers is one batch, after each new instance completes `start`. If one fails, no consumer changes.
- If the new `build` or `start` fails, `replace()` rejects and the old instance does not change. This is also the usual fix for an `unavailable` provider.
- The old instance stops after each dependent releases it. A dependent with a `dependency-change` handler moves in place. Other dependents rebuild without a gap, so a replacement deep in the graph does not stop the units above it.
- `graph(container).explain(key)` shows the new instance as `replacement` while the swap waits, with its phase and blockers.
- A stale registration, or a call that a newer `replace()` or a withdrawal supersedes, resolves `false`. A unit in `stopping` rejects with `ReplaceWhileStoppingError`.
- `replace(option, { signal })` cancels the pending replacement when the signal aborts, and rejects. A newer `replace()` still resolves `false`, so a caller can tell a timeout from a supersede. See [Cancellation](#cancellation).

```ts
try {
  await extension.replace({ dependsOn: { gateway: gatewayKey }, build: createExtension }, { signal: timeout(container, 5_000) })
}
catch (error) {
  if (error instanceof WaitTimeoutError)
    // replace('extension') timed out before the swap. The replacement is not running:
    // - extension is pending: no provider for 'airi.gateway' (gateway)
    report(error.message)
  else
    throw error
}
```

- The message of the `WaitTimeoutError` explains the new instance at the timeout. For a per-container registration, it has one line for each consumer unit that did not complete `start`. The replacement is gone after the abort, so `graph(container).explain()` no longer shows it.

### Transactions

A transaction publishes many units together, for example all parent-visible units of one plugin.

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-plugin-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-plugin-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="Load a plugin with many units. With a provide() for each unit, memory runs and agent fails, so half of the plugin is live. With tx.commit(), memory builds while consumers see neither unit. When a build fails in the transaction, nothing is published." src="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-plugin-light.webp" />
</picture>

```ts
import { transaction } from 'injeca'

const tx = transaction(container)
tx.declare(statusKitKey, { dependsOn: { character: characterKey } })
tx.provide(statusKitKey, { build: ({ dependsOn }) => createStatusKit(dependsOn) })
tx.provide(characterKey, () => createCharacter())
await tx.commit()
```

- Nothing is visible to consumers before `commit()`. Graph queries show the declared units.
- `commit()` builds in dependency order. A unit can use another unit of the same transaction.
- If all builds succeed, the units publish in one batch, then their `start` hooks run. If one build fails, nothing publishes and `commit()` rejects.
- A unit whose dependencies are not available goes to `pending`. That is not a failure.
- A declared unit without `provide` fails the commit with `TransactionIncompleteError`, unless it is declared with `optional: true`.
- `tx.replace(key, option)` replaces a registration at the commit. `tx.abort()` and the disposal of the container drop everything.
- `tx.declare` and `tx.provide` reserve the key until the commit or the abort. Another `provide` of the key in the same container fails with `DuplicateUnitError`. For an exclusive key, a provider in another container of the area goes to `conflict` until the abort.
- `withdraw()` on the result of `tx.provide` before the commit removes that provide and resolves `true`. A declared key without a provide then fails the commit.
- `tx.commit({ signal })` aborts the transaction when the signal aborts before the publish. See [Cancellation](#cancellation).

## Keys without a provider

`defineKey` creates a typed key. A consumer can depend on it before any provider exists. It stays `pending` and runs no code until a provider registers.

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-late-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-late-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="Depend on a key that a plugin provides later. With a plain key, speech and app wait in pending. With optional(), speech runs at once without a TTS. With firstAvailable(), speech uses local-tts, and moves to remote-tts when it runs." src="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-late-light.webp" />
</picture>

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

- A plain key is required. The dependent waits for it.
- `optional(key)` gives `{ value, status }`, or `undefined` without a provider. The dependent builds at once, and rebuilds when the provider appears or goes.
- `firstAvailable(...keys)` selects the first candidate that runs and is available. When a candidate earlier in the list starts to run, the dependent moves to it.

### Exclusive keys

An exclusive key can have only one provider in its resolution area: the container that has the key, with its descendants.

```ts
const whiteboardKey = defineKey<Whiteboard>('dev.airi.whiteboard', { exclusive: true })
```

If two containers in one area provide it, both go to `conflict`, in any order. They run no code, and their dependents stay `pending`. When one provider is removed, the other converges. `graph(container).explain()` lists the owner of each provider. The [Containers](#containers) figure shows this case.

A [parent-visible registration](#visibility-to-the-parent-container) counts in the area of the parent container. So two sibling plugins that make one exclusive key visible to the parent conflict, and so do a host registration and a parent-visible plugin registration of that key.

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

A running unit is `ready`, `degraded`, or `unavailable`.

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-status-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-status-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="A provider loses its connection. With setStatus('unavailable'), chat and app are unavailable with the same instances, and notes, which uses llm as optional, stays ready. With setStatus('degraded'), chat and app are degraded. With withdraw(), chat and app stop and wait, and notes builds again without llm." src="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-status-light.webp" />
</picture>

- `degraded` means that calls still complete, at lower quality.
- `unavailable` means that the instance exists, but calls fail now.
- The effective status of a unit is the worst of its own status and the effective status of each required dependency. It goes down the graph.
- An optional dependency does not change the effective status.
- A dependency that becomes `unavailable` does not stop or rebuild its dependents. They get a `dependency-status-change` call if they register a handler.
- Use a status for a condition that passes, such as a reconnect. Withdraw a unit only when it is gone for good.

```ts
build: ({ setStatus }) => {
  const client = connect()
  client.on('reconnecting', () => setStatus('unavailable', { reason: 'reconnecting' }))
  client.on('ready', () => setStatus('ready'))
  return client
}
```

## Containers

Create containers to keep tests apart, or to give each plugin its own child container.

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

A child container resolves keys from its ancestors. It does not start until `start(child)` runs, so a caller can register all its units first.

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-containers-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-containers-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="A plugin brings its own theme. A provider in the child container shadows the host theme only while it runs, so view keeps the host theme while the plugin theme builds. With isolate, view waits for the plugin theme. With an exclusive key, both providers go to conflict, and app and view wait." src="https://raw.githubusercontent.com/moeru-ai/injeca/main/docs/assets/banners/compare-containers-light.webp" />
</picture>

```ts
const plugin = createContainer({
  parent: injeca.getContainer(),
  owner: { kind: 'plugin', id: 'agent-activity' },
})

provide(plugin, 'agent-activity:reaction', { dependsOn: { llm: llmKey }, build: () => createReaction() })
effect(plugin, () => () => console.info('plugin cleaned up'))

await start(plugin, { signal: timeout(plugin, 10_000) })
await dispose(plugin)
```

- `stop()` stops. `dispose()` also withdraws the registrations and runs the container effects. A disposed container cannot be used again.
- `dispose(parent)` disposes the child containers first, newest first, each one with its effects. Then the units of the parent stop, and then its effects run.
- `effect(container, setup)` after the disposal started runs the disposer at once.
- `start(container, { signal: timeout(container, ms) })` rejects with a `StartTimeoutError` that explains each unit that is not running. injeca has no built-in timeout.
- A unit with a missing provider, or in a dependency cycle, stays `pending`. Use a timeout signal to find it.
- A provider in a child container shadows the provider of an ancestor only while it is `running`. Until then, and after it stops, dependents use the ancestor provider. So shadowing never leaves a gap.
- `createContainer({ isolate: [key] })` stops a key from resolving from the ancestors. It also hides the parent-visible units of the sibling containers. It does not hide the parent-visible units of its own child containers.
- A `stop` or `dispose` call from a cleanup of the same container, or of a descendant, does not wait for itself. The same is true for a cleanup of a unit that holds a unit of the container. It warns and resolves at once. See [Calling dispose from a cleanup](#calling-dispose-from-a-cleanup).

### Logging

`logging: true` writes the lifecycle trace: each `provide`, `invoke`, build, `start` and `stop` hook, and `running`. It is off by default.

```ts
import { createContainer, createLoggLogger, createNoopLogger, injeca } from 'injeca'

const app = createContainer({ logging: true }) // writes PROVIDE, RUN, HOOK OnStart, RUNNING, and the other lines
const plugin = createContainer({ parent: app, logging: false }) // a child uses the value of its parent, unless it sets its own
const quiet = createContainer({ logger: createNoopLogger() }) // also no warnings, for tests

injeca.getContainer().logging = true // the global container
injeca.setLogger(createLoggLogger(logg)) // a logger from @guiiai/logg
```

- `logger.warn` always writes, whatever `logging` is. injeca warns for a re-entrant call, a `stop` timeout, and a late failure of a callback that it stopped waiting for.
- The logger is `options.logger`, then the logger of the parent container, then `createDefaultLogger()`. It writes with `console`.

### Visibility to the parent container

A registration in a child container is visible only in that container and its descendants. This is `visibility: 'local'`, the default. `visibility: 'parent'` also makes it a candidate for consumers in the area of the parent container: the parent and each of its descendants. So a plugin can use a Kit that another plugin provides.

```ts
const host = createContainer({ owner: { kind: 'host' } })
const pluginA = createContainer({ parent: host, owner: { kind: 'plugin', id: 'a' } })
const pluginB = createContainer({ parent: host, owner: { kind: 'plugin', id: 'b' } })

provide(pluginA, memoryKitKey, { visibility: 'parent', build: () => createMemoryKit() })
provide(pluginB, 'b:session', { dependsOn: { memory: memoryKitKey }, build: ({ dependsOn }) => startSession(dependsOn.memory) })
```

- The registration stays in its container. That container owns it, and `dispose(pluginA)` withdraws it. Its own dependencies resolve from that container. This is also true for a per-container registration.
- The registration is visible exactly one level up. A container that wants to reach the area of its grandparent provides the key at its own level.
- A consumer looks in its own container, then in each ancestor. At each level, the registration of that container comes first, then the parent-visible units of its children in creation order.
- Shadowing still has no gap. A parent-visible unit takes over from a provider of a farther ancestor only while it runs.
- `instances: 'per-container'` and `visibility: 'parent'` combine. Each consumer instance lives in the consumer container.
- `tx.provide(key, { visibility: 'parent', ... })` reserves an exclusive key in the parent area at once, and the commit publishes the unit there in one batch.
- `replace()` keeps the visibility. On a root container, `visibility: 'parent'` has no effect.
- `graph(parent)`, `peek`, `watch`, `waitFor`, and `observe` see the unit. `graph().units()` marks it with `visibility: 'parent'`, and its `owner` is the owner of its own container.

### Per-container instances

A registration has one instance for all consumers by default. This is `instances: 'shared'`. `instances: 'per-container'` runs `build` once for each consumer container. The build context has `consumer`, the owner record of that container. The instance disposes with the consumer container.

The instance lives in the consumer container, but its `dependsOn` resolves from the container of the registration, as for a plain registration. So a key of the consumer container does not change the dependencies of the registration.

A dependent demands its consumer instance through a required, an optional, or a `firstAvailable` edge. This is also true when the key registers after the dependent.

A failed consumer instance builds again on the next demand from its container: a new `resolve`, `watch`, or `waitFor` call, or a dependent that starts to wait. Each demander gets one new build for each failure.

```ts
const hostClient = injeca.provide('host:client', {
  instances: 'per-container',
  metadata: { api: 'v1' },
  build: ({ consumer }) => createHostClient(consumer),
})
```

`metadata` is a frozen record on any registration. Resolution conditions and graph queries read it.

## Reading state

```ts
import { observe, timeout, waitFor, watch } from 'injeca'

const container = injeca.getContainer()

const stopWatching = watch(container, server, ({ phase, status }) => {})
await waitFor(container, server, { status: 'ready', signal: timeout(container, 5_000) })
const stopObserving = observe(container, (record) => {})
```

- `watch` sends the current state at once, then each change, in order.
- `waitFor` rejects with a `UnitFailedError` (`unit-failed`) when the unit failed, or waits for a required provider that failed. Its `cause` is the failure.
- For a per-container key, `watch` and `waitFor` create the consumer instance for their container, as `resolve` does. The demand ends with the subscription.
- `observe` sends each phase change, status change, decision, hook timeout, aborted wait, and re-entrant call in the container and its children.

`peek` reads a value now, without a wait, and never builds anything. `resolve` takes `signal` to stop a wait:

```ts
import { peek, resolve, timeout, where } from 'injeca'

const result = peek(container, where(llmKey, ({ metadata }) => metadata.version === '2'))
if (result.kind === 'resolved')
  result.value.chat()
else
  console.info(result.kind) // 'missing', 'rejected', 'conflict', 'not-running', or 'unavailable'

const { llm } = await resolve(container, { llm: llmKey }, { signal: timeout(container, 5_000) }) // rejects with WaitTimeoutError
```

### Graph queries

`graph(container)` reads the graph of the container and its children. It never changes state.

```ts
import { graph } from 'injeca'

const queries = graph(container)

queries.units() // all units, with the declared units of open transactions
queries.dependencies(server) // the direct edges of a unit
queries.dependents(config) // the units that use a unit now
queries.order() // providers before their dependents
queries.cycles() // each dependency cycle
queries.explain(server) // why a unit is not running, also for a key without a provider, with a pending replacement
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

## Packages

| Package | Description | Status |
| --- | --- | --- |
| [`injeca`](https://github.com/moeru-ai/injeca/blob/main/packages/injeca) | The container: units, lifecycle hooks, run-time changes, status propagation, and child containers | Published |
| [`@injeca/bridge`](https://github.com/moeru-ai/injeca/blob/main/packages/bridge) | Connects an eventa channel to a child container, so that plugins in other processes and languages can share and use units | Planned |

Transport packages that open a channel and report it as a unit use the name `@injeca/channel-<transport>`, for example `@injeca/channel-websocket`.

More documentation:

- [The injeca 0.3 design](https://github.com/moeru-ai/injeca/blob/main/docs/design-0.3.md): the decisions, the phases, and the convergence rules
- [The injeca agent skill](https://github.com/moeru-ai/injeca/blob/main/skills/injeca/SKILL.md): `npx skills add moeru-ai/injeca`
- [The scenario lab](https://injeca.moeru.ai/), from [`apps/docs`](https://github.com/moeru-ai/injeca/blob/main/apps/docs)

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

- `start()` waits for a missing provider. 0.2 threw an error. Use `start(container, { signal: timeout(container, ms) })` to fail after a time.
- `resolve()` waits for a missing provider too. Before `start()`, it builds the units that it needs, with their `start` hooks.
- `invoke()` returns a handle with `key` and `withdraw()`. Graph queries accept `key`. Its callback runs again when a required dependency gets a new instance.

## Migration from 0.3 to 0.4

0.4 removes the `timeoutMs` option of `resolve`, `waitFor`, and `start`. Pass a signal from `timeout(container, ms)`:

```ts
// 0.3
await resolve(container, { llm: llmKey }, { timeoutMs: 5_000 })
await waitFor(container, server, { status: 'ready', timeoutMs: 5_000 })
await start(container, { timeoutMs: 10_000 })

// 0.4
await resolve(container, { llm: llmKey }, { signal: timeout(container, 5_000) })
await waitFor(container, server, { status: 'ready', signal: timeout(container, 5_000) })
await start(container, { signal: timeout(container, 10_000) })
```

- The errors do not change. A timeout gives `WaitTimeoutError` or `StartTimeoutError`. The error message no longer has the milliseconds. The `cause` is the `TimeoutError` reason.
- A call with `timeoutMs` and `signal` becomes one signal: `withTimeout(signal, ms, container)`.
- A `TimeoutError` reason from your own signal, for example `AbortSignal.timeout()`, now also gives `WaitTimeoutError` or `StartTimeoutError`. Another reason rejects as it is, as before.
- `stop`, `dispose`, `withdraw`, `replace`, and `tx.commit` take `{ signal }` too. See [Cancellation](#cancellation).
- `timeouts: { start, stop }` and `onTimeout` keep their shape. A `stop` handler now sees the `stop` timeout on its `signal`.
- A `stop` timeout no longer fails `stop()`, `dispose()`, or `withdraw()`. Without `onTimeout`, it counts as `handled`, with a warning. In 0.3, the callers rejected with `HookTimeoutError`. To keep a failure, return `context.decide.fail(error)` from `onTimeout` for the `stop` hook.
- `observe` has two new record types, `wait-aborted` and `reentrant-call`. A `switch` on `record.type` with an exhaustive check needs a case for each. Their `call` can be `'stop'`, `'dispose'`, or `'withdraw'`.
- `ReentrantDisposeError` (`reentrant-dispose`) is removed. A `stop()`, `dispose()`, or `withdraw()` from a cleanup that its wait includes resolves at once with a warning. See [Calling dispose from a cleanup](#calling-dispose-from-a-cleanup).
- A custom `Logger` needs `warn(message)`. `createDefaultLogger`, `createLoggLogger`, and `createNoopLogger` have it. injeca also writes stop timeouts and late failures of abandoned callbacks with it.
- `injeca/testing` exports `manualClock` and `drained`. See [Testing with a manual clock](#testing-with-a-manual-clock).
- The `enabled` option of `createContainer` is removed. The lifecycle logs are off by default. `logging: true` turns them on. Warnings always go to the logger. See [Logging](#logging).

```ts
// 0.3
createContainer({ enabled: false }) // no logs
createContainer() // lifecycle logs

// 0.4
createContainer({ logger: createNoopLogger() }) // no logs and no warnings. Or remove the option to keep the warnings.
createContainer({ logging: true }) // lifecycle logs
```

## Migration from 0.4 to 0.5

0.5 has two breaking changes. It renames "service" to "unit", and an aborted `replace()` signal rejects.

### Service is now unit

0.5 renames "service" to "unit". A unit is a registration that `provide()` makes, with the instances that it builds. 0.5 also renames the options for sharing and visibility. The rename does not change the behavior.

```ts
// 0.4
provide(root, 'host:client', { perConsumer: true, build: ({ consumer }) => createHostClient(consumer) })
provide(pluginA, memoryKitKey, { export: true, build: () => createMemoryKit() })
graph(container).services()

// 0.5
provide(root, 'host:client', { instances: 'per-container', build: ({ consumer }) => createHostClient(consumer) })
provide(pluginA, memoryKitKey, { visibility: 'parent', build: () => createMemoryKit() })
graph(container).units()
```

| 0.4 | 0.5 |
| --- | --- |
| `perConsumer: true` | `instances: 'per-container'`. The default is `'shared'`. |
| `export: true` | `visibility: 'parent'`. The default is `'local'`. |
| `graph(container).services()` | `graph(container).units()` |
| `GraphService` with `perConsumer: boolean` and `exported: boolean` | `GraphUnit` with `instances: 'shared' \| 'per-container'` and `visibility: 'local' \| 'parent'` |
| `kind: 'service'` in `GraphService` and `ServiceExplanation` | `kind: 'unit'` |
| `decision.service` | `decision.unit` |
| `DuplicateServiceError` (`duplicate-service`) | `DuplicateUnitError` (`duplicate-unit`) |
| `ServiceFailedError` (`service-failed`) | `UnitFailedError` (`unit-failed`) |
| `ServicePhase`, `ServiceStatus`, `ServiceState` | `UnitPhase`, `UnitStatus`, `UnitState` |
| `ServiceHook`, `ServiceMetadata` | `UnitHook`, `UnitMetadata` |
| `ServiceBlocker`, `ServiceExplanation` | `UnitBlocker`, `UnitExplanation` |

- 0.5 has no aliases for the old names. TypeScript shows each old name as an error. Replace each one with its new name.
- `instances` and `visibility` accept only the values in the table. Another value, for example `true`, throws `InvalidArgumentError`.
- An old option such as `perConsumer: true` or `export: true` is not read any more, and the type check rejects it in an object literal. Without the type check, the registration is shared and local.
- Check the error codes in your own `catch` blocks and the `kind` values in your own code that reads graph queries.

### An aborted replace() rejects

0.5 changes the result of `registration.replace(option, { signal })` when the signal aborts before the swap. In 0.4, it resolved `false`, the same result as for a newer `replace()`. Now it rejects:

```ts
// 0.4
const replaced = await registration.replace(option, { signal: timeout(container, 5_000) })
if (!replaced)
  console.warn('superseded or timed out') // cannot tell which

// 0.5
try {
  const replaced = await registration.replace(option, { signal: timeout(container, 5_000) })
  if (!replaced)
    console.warn('a newer replace() or a withdrawal superseded it, or the registration is stale')
}
catch (error) {
  if (!(error instanceof WaitTimeoutError))
    throw error
  console.warn(error.message) // names the unmet dependencies of the new option
}
```

- A timeout reason rejects with `WaitTimeoutError` (`wait-timeout`). Its `cause` is the reason. Its message tells what the new instance waited for.
- Another reason rejects as it is, as for `resolve`.
- An aborted signal rejects at once and changes nothing. In 0.4, it resolved `false`.
- A stale registration, a newer `replace()`, and a withdrawal still resolve `false`. A swap still resolves `true`.
- Remove a `resolve()` of the new dependencies before `replace()` that only gave a timeout error. The `replace()` error has the same information now.
- `tx.commit({ signal })` does not change.

## Documentation automation

The table of contents comes from `doctoc`. `packages/injeca/README.md` is a copy of this README, so npm shows the same guide. Run this after you change this README:

```sh
pnpm docs:update
```

`docs:update` refreshes the table of contents, then copies this README to the package. In the copy, relative links point to GitHub, and images point to raw.githubusercontent.com. Do not edit the copy.

The figures come from the scenario lab in [`apps/docs`](https://github.com/moeru-ai/injeca/blob/main/apps/docs). Render them again after a change of the lab or of the behavior that it shows:

```sh
pnpm -F @injeca/docs banners
```

The tests in `apps/docs/src/lab/lab.test.ts` run each scenario against the source and keep its frames in snapshots. When a change of injeca changes a figure, a snapshot changes first.

## Development

This repository is a pnpm workspace.

```sh
pnpm install
pnpm typecheck
pnpm test:run
pnpm lint
pnpm build
pnpm -F @injeca/docs dev # the scenario lab
```

## License

[MIT](https://github.com/moeru-ai/injeca/blob/main/LICENSE)

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
[lab-swap]: https://injeca.moeru.ai/#swap/replace
[lab-handler]: https://injeca.moeru.ai/#swap/handler
[lab-status]: https://injeca.moeru.ai/#status/unavailable
[lab-late]: https://injeca.moeru.ai/#late/required
[lab-retry]: https://injeca.moeru.ai/#retry/requeue
[lab-plugin]: https://injeca.moeru.ai/#plugin/commit
[lab-containers]: https://injeca.moeru.ai/#containers/shadow
[lab-exclusive]: https://injeca.moeru.ai/#containers/exclusive
