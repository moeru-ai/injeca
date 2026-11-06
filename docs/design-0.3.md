# injeca 0.3 design

Status: accepted
Date: 2026-11-04
Interactive model: [injeca Graph Lab](https://claude.ai/artifact/KYnT7yNT4KDxzAgGnqJju1)

## Context

injeca 0.2 is a function-based container. It builds each service once at `start()`, then starts and stops all services as one unit. The Electron main process of AIRI (`stage-tamagotchi`) is its largest user. It registers 33 services in `src/main/index.ts`: configs, windows, the tray, servers, the plugin host, and platform modules.

injeca 0.3 keeps this model and adds new capabilities on top of it:

1. **Lifecycle in `build`.** A service registers its own `start` and `stop` hooks and effects.
2. **Dependency awareness.** A service has a phase and a status. Other code can read, watch, and wait for them.
3. **Run-time changes.** Services can appear, disappear, and change after `start()`. Dependents converge automatically: they stop, rebuild, or move to the new instance.
4. **Inversion of control.** A consumer depends on a key that a different module, or a plugin, provides later.

The two main beneficiaries are `stage-tamagotchi` and `@proj-airi/plugin-sdk`:

| Capability | stage-tamagotchi | plugin-sdk |
| --- | --- | --- |
| Lifecycle in `build` | Windows, the tray, servers, and trace services own their start and stop | Extension setup and teardown |
| Dependency awareness | Platform modules such as `apple-vision` report when they cannot work. Dependents degrade. | Kit readiness and withdrawal |
| Run-time changes | A config change rebuilds the services that use it. A window closes and opens again. Main-process hot reload replaces a changed module. | Extension load, unload, and reload |
| Inversion of control | `plugin-host` and `mcp-manager` use contracts that other modules provide | Consumers use Kit contracts that provider extensions implement |

plugin-sdk has four registries that implement parts of these capabilities by hand. They show that the capabilities are necessary. Their design is not a requirement for injeca. See [Appendix: plugin-sdk](#appendix-plugin-sdk).

## Decisions

These decisions are made. Do not reopen them in the implementation.

1. injeca 0.3 extends the 0.2 API. The 0.2 mechanisms stay: `provide` by name with a typed key as the result, the function shorthand, `dependsOn` with keys or names, `invoke`, `resolve`, `start`, `stop`, `createContainer` with the functions that take a container, and the global `injeca` object.
2. injeca can have the capabilities of Cordis, but its API is function based. Do not add `Service` subclasses, a class-based context, or TypeScript declaration merging on a context object.
3. injeca owns the only dependency graph. A consumer does not build a second graph.
4. injeca converges automatically at run time. It uses the Cordis method: an epoch from the dependency identities, one serial transition for each service, and teardown that waits for dependents.
5. A consumer does not need a planning stage before a change. A service with missing dependencies stays `pending` and runs no code. Diagnostics come from graph queries. Duplicate providers use exclusive keys. Version checks use resolution conditions.
6. Hooks return a `Decision`. Only the `decide` object in the hook context creates it. injeca does not export a top-level `decide`. A value that is not a decision counts as `undefined`.
7. `alien-signals` owns change tracking and notification inside injeca. It is not part of the public API.
8. injeca does not define an event format or a transport. Cross-process work uses `@moeru/eventa` in the consumer.
9. injeca 0.3 can break small parts of the 0.2 API. It removes the `lifecycle` key, because `on('start')` and `on('stop')` in `build` replace it. AIRI migrates its callers in one pull request. Do not add compatibility guards.

## Goals

- Keep the 0.2 call style. Code that does not use `lifecycle` works without changes.
- Hooks, effects, and an abort signal in the `build` context.
- Registration, withdrawal, and replacement at run time, before and after `start()`.
- Protection against a stale registration that removes a newer one.
- Automatic convergence when dependencies change.
- A phase and an effective status for each service, with watch, wait, and an observe stream.
- Keys that a consumer can depend on before any provider exists.
- Child containers with ownership and reverse-order disposal.
- Transactions, atomic replacement, exclusive keys, and resolution conditions.
- Decisions with requeue.
- Graph queries for diagnostics, inspection, and impact preview.
- A base for an experiment with Electron main-process hot reload.

## Non-goals

- Configuration loading, YAML, or patch layers.
- File watching. A hot reload tool watches files and calls `replace()`. injeca gives the replacement primitive.
- General event dispatch modes (`emit`, `parallel`, `serial`, `bail`, `waterfall`). See [Listener registry](#listener-registry).
- Cross-process transport.
- Kit semantics: Contracts, `KitValue`, semantic version ranges, exposure policy, permissions, Manifest checks, routing.
- Built-in timeouts or retry limits. Each caller configures them.

## Concepts

| Term | Meaning |
| --- | --- |
| Container | The root of one graph, or a child of another container. It has an owner. It owns its registrations, invocations, effects, listeners, and child containers. |
| Key | A typed identity for a service: the `ProvidedKey` of 0.2. `provide` returns one. `defineKey` creates one without a provider. |
| Registration | One `provide` call. Its result is a key with `withdraw()` and `replace()`. Only the current registration can use them. |
| Service | The registration of a key in a container. It has a phase, declared dependencies, and at most one current instance. |
| Instance | One built value of a service. Each instance has a unique `instanceId`. A rebuild or a replacement creates a new instance. |
| Invocation | One `invoke` call. It is a service without a value: its callback runs when its dependencies are available. |
| Epoch | The identity of the current dependency set of a service: its revision plus the `instanceId` of each resolved required dependency. |
| Own status | The status that an instance sets for itself. |
| Effective status | The worst of the own status and the effective status of each required dependency. |
| Holder | A service or an invocation that holds a binding to an instance of another service. |
| Decision | The value that a hook returns to tell injeca what to do next. |

## API

### What stays

The 0.2 call style stays. The names, overloads, auto-naming from the call stack, and type inference stay.

```ts
import { injeca } from 'injeca'

// provide by name. The result is a typed key.
const appConfig = injeca.provide('configs:app', () => createGlobalAppConfig())

// The object form with dependsOn. The build context still has dependsOn, name, and container.
const server = injeca.provide('modules:airi-http-server', {
  dependsOn: { appConfig },
  build: ({ dependsOn }) => createServer(dependsOn.appConfig),
})

// invoke runs when the dependencies are available.
injeca.invoke({
  dependsOn: { server },
  callback: ({ server }) => registerRoutes(server),
})

// resolve gives the values.
const { server: s } = await injeca.resolve({ server })

await injeca.start()
await injeca.stop()
```

The same functions exist for a container that `createContainer()` returns: `provide(container, ...)`, `invoke(container, ...)`, `resolve(container, ...)`, `start(container)`, and `stop(container)`.

### What changes

| 0.2 | 0.3 |
| --- | --- |
| `dependsOn: { lifecycle }` and `lifecycle.appHooks.onStart/onStop` | `on('start')` and `on('stop')` in the build context |
| `provide` before `start()` only | `provide` before or after `start()`. After `start()`, the new service builds and starts when its dependencies are available. |
| `start()` builds everything once | `start()` begins convergence. It resolves when all registered services and invocations reach `running`, or rejects with the build and start errors. A required key without a provider keeps it waiting. `start({ timeoutMs })` rejects after the timeout with the `explain()` result. |
| `stop()` stops everything once | `stop()` stops all instances. Dependents stop before their providers. The registrations stay, and a later `start()` builds them again. `dispose()` clears the container. |
| `resolve()` throws when a provider is missing | `resolve()` waits until the provider registers. Before `start()`, it builds and starts the services that it needs, with their `start` hooks. |
| An invocation runs once | An invocation runs again when a required dependency gets a new instance. See [Invocations](#invocations). |

### What is new

```ts
import { createContainer, defineKey, injeca, optional, watch } from 'injeca'

// A key without a provider. A consumer can depend on it now. A plugin provides it later.
const ttsKey = defineKey<TtsClient>('airi.tts')

const speech = injeca.provide('voice:speech', {
  dependsOn: { llm: llmKey, tts: optional(ttsKey) },
  build: ({ dependsOn, on, effect, signal, setStatus }) => {
    const speech = createSpeech(dependsOn.llm, dependsOn.tts?.value)

    on('start', async ({ decide, attempt }) => {
      try {
        await speech.listen()
      }
      catch (error) {
        return decide.requeue({
          backoff: { kind: 'exponential', initial: 500, max: 30_000 },
          maxAttempts: 5,
          reason: errorMessageFrom(error),
        })
      }
    })
    on('stop', () => speech.drain())

    on('dependency-change', ({ dependsOn, decide }) => {
      speech.setTts(dependsOn.tts?.value)
      return decide.handled()
    })
    on('dependency-status-change', ({ dependsOn, decide, attempt }) => {
      if (dependsOn.tts?.status !== 'ready' && attempt < 10)
        return decide.requeue({ after: 1_000, reason: 'TTS is warming up' })
      return decide.handled()
    })

    effect(() => subscribeToSomething())
    return speech
  },
})

// A plugin provides the key later. Dependents converge.
const tts = injeca.provide(ttsKey, () => createTts())

// Atomic replacement, for example from a hot reload tool.
await tts.replace(() => createTtsV2())

// Withdrawal. Dependents stop first.
await tts.withdraw()

// A child container with an owner. dispose() withdraws everything in it.
const extension = createContainer({ parent: rootContainer, owner: { kind: 'extension', id: 'agent-activity' } })
await dispose(extension)

// Reading state.
const stop = watch(rootContainer, speech, ({ phase, status }) => {})
```

### Remote plugins

A plugin in another language connects through an eventa channel. eventa has implementations in other languages, for example eventa.net for C#. A bridge package, not the injeca core, maps the channel to injeca:

- Each remote plugin gets a child container. The channel is a service in it. Its status follows the connection.
- Each service that the plugin exports is a proxy service. It requires the channel service. Its value is an RPC client for the Kit contract. Its own status comes from the plugin through `setStatus` with a cause chain.
- The plugin manages the dependencies inside it. It reports only the effective status of each export.
- The `instanceId` of an export crosses the bridge. A plugin that reconnects without a restart keeps its instances, so nothing rebuilds. A restarted plugin reports new instances, so dependents get `dependency-change`.
- A plugin that depends on a host service declares it. The bridge creates an invocation on the host side that forwards the value as RPC and the status to the plugin.
- One announcement with many exports is one transaction.

The core needs only `setStatus` after `build`, cause chains, transactions, and child containers for this.

## Containers and keys

### Containers

- `createContainer(options?)` returns a container. `options.parent` makes a child container. `options.owner` is a serializable owner record. injeca does not interpret its fields.
- A container resolves keys from its own registrations and from those of its ancestors. It also resolves the [exported registrations](#exported-registrations) of the child containers of each of these containers.
- A registration in a child container shadows an ancestor provider of the same key only while it is `running`. Until then, dependents keep the ancestor provider. When the child provider starts, dependents move to it, and they get `dependency-change`. When it stops, they move back to the ancestor provider. So shadowing never leaves a gap.
- A container can isolate a key. Then the key does not resolve from the ancestors. `createContainer({ isolate: [key] })` sets the isolated keys. They do not change later. An isolated key also ends the resolution area of an exclusive key of an ancestor.
- An isolated key also hides the exports of the sibling containers, because they are in the area of the parent. It does not hide the exports of the own child containers, because they are in the area of the container itself.
- `watch(container, key)` reports the provider that a consumer in `container` resolves. With shadowing, that is the ancestor provider until the child provider runs.
- `dispose(container)` disposes the child containers first, one after the other, in reverse creation order. Each child disposal completes, with its own effects, before the next one starts. Then the registrations and invocations of the container withdraw in one batch. Then the effects of the container run in reverse registration order.
- The whole subtree enters disposal at once. No new registration, child container, or transaction can start in it.
- `dispose()` collects all errors. One error keeps its identity. More than one error becomes an `AggregateError`.
- A dispose call from the synchronous part of a cleanup in the same container, or in a descendant, rejects with `reentrant-dispose`. The check is the same in every runtime. injeca does not track a call across `await`, because the web has no runtime async context.
- A cleanup must not await the disposal of its own container or of an ancestor. injeca does not detect this after an `await`. A configured `stop` timeout ends such a cleanup with a failure, and the disposal continues.
- An outside caller that calls `dispose()` again during disposal gets the same promise.
- `stop(container)` stops. `dispose(container)` cleans up. `stop()` stops all instances, dependents first, and keeps the registrations. The container stays usable, and a later `start()` builds the registrations again. `stop()` also ends the demands of `resolve`, `watch`, and `waitFor` on the services of the container. `dispose()` also withdraws the registrations, disposes the child containers, and runs the container effects. A disposed container cannot be used again.
- `start(container, { timeoutMs? })` has no built-in timeout. When a configured timeout passes, it rejects with the `explain()` result of each service that is not `running`.
- A child container does not start when it is created. Its registrations and invocations wait until `start(child)` runs. This gives the caller time to register all services of the child first. `start(parent)` and `stop(parent)` apply to each child container that was started. A direct `stop(child)` removes the child from this set, so a later `start(parent)` leaves it stopped.
- A service in `failed` tries again on the next `start()`.
- `effect(container, setup)` adds an effect to a container. `dispose()` runs it.
- `effect(container, setup)` on a container whose disposal started or ended runs `setup`, then runs its disposer at once. So a late resource does not leak. A disposer that throws throws to the caller. A disposer promise that rejects goes to the runtime as an unhandled error.
- The global functions use one root container. `getContainer()` returns it.

### Keys

- `provide(name, ...)` returns a typed key, as in 0.2. `ProvidedKey` has an optional phantom property that carries the value type. A plain `{ key: 'name' }` object is still valid.
- The key from `provide` also has `withdraw()` and `replace(option)`. See [Registrations](#registrations).
- `defineKey<T>(name, options?)` returns a typed key without a provider. `provide(key, ...)` registers a provider for it. The type of `build` must match `T`.
- `options.exclusive: true` makes an exclusive key. See [Exclusive keys](#exclusive-keys).
- `provide(container, key, { export: true, ... })` exports the registration to the area of the parent container. See [Exported registrations](#exported-registrations).
- `dependsOn` accepts a key, the result of a `provide`, or a name, as in 0.2.
- `optional(key)` marks an optional dependency. `where(key, condition)` adds a resolution condition. The two can combine.
- `firstAvailable(keyA, keyB, ...)` marks a fallback dependency. See [Fallback dependencies](#fallback-dependencies).
- Types come from the key. Do not use declaration merging.

### Exported registrations

A registration in a child container is invisible to its parent and to its siblings. So plugin A, a child of the plugin host container, cannot use a Kit that plugin B, another child, provides. An exported registration fixes this.

- `provide(child, key, { export: true, ... })` exports the registration. `tx.provide` takes the same option. The global and scoped forms of `provide` take it too.
- The registration lives in the child container. The child owns it. `dispose(child)` withdraws it, and `impact({ kind: 'dispose', container: child })` counts it. Its own dependencies resolve from the child. Its phases and status are the usual ones.
- An exported registration is also a candidate for consumers in the resolution area of the parent container: the parent itself and each descendant of the parent. So the siblings and their children see it.
- An export goes exactly one level up, to the area of the direct parent. A container that wants to reach the area of its grandparent exports from its own level. For example, a plugin container re-exports a service of its child.
- On a root container, `export` has no effect.
- A consumer looks in its own container, then in each ancestor in turn. At each level, the candidates are the registration of that container, then the exports of the child containers of that container, in container creation order.
- At one level, the own registration of the container comes before an export of the same plain key. With the shadowing rule, it serves while it runs. Until then, a running export serves.
- The shadowing rule applies to exports without a change. An export takes over from a provider of a farther ancestor only while it is `running`. Dependents move with `dependency-change`, and they move back when the export stops. So an export never leaves a gap.
- `replace()` keeps the export, as it keeps `perConsumer`.
- A `perConsumer` registration can be exported. Each consumer service lives in the consumer container and disposes with it. Its `consumer` is the owner of the consumer container. Its own dependencies resolve from the exporting container, as for a plain export.
- `tx.provide(key, { export: true })` reserves an exclusive key in the area of the parent container at once. The commit publishes the service there in the same batch as the other services of the transaction.
- `graph(container)` queries, `peek`, `watch`, `waitFor`, and `observe` see an export from the parent area. The `owner` of the export is the owner of the exporting container. `graph().services()` marks an export with `exported: true`. `observe(parent)` gets its records, because the exporting container is a child of the parent.

### Exclusive keys

- An exclusive key can have only one provider in its resolution area. A resolution area is the container that has the key, with its descendants that do not isolate the key.
- An exported registration counts as a declaration in the resolution area of its parent container. So two sibling exports of one exclusive key both go to `conflict`, in either order. A registration of the parent and an export of a child conflict too. An export also conflicts with a registration of a sibling, because the sibling sees both.
- If two or more registrations provide the same exclusive key in one resolution area, all of them go to `conflict`. No registration wins.
- injeca decides the conflict from the set of registrations. The order has no effect.
- A service in `conflict` runs no code. Its dependents stay `pending`.
- When only one registration remains, that service leaves `conflict` and converges.
- `explain()` lists the owners of all conflicting registrations, in container order.
- A registration of the same name without the exclusive marker counts as a declaration. A conflict needs only one exclusive declaration.
- A `running` service stops when a second declaration appears. Then it goes to `conflict`.
- The conflict is a phase, not an error. No call throws an error for it.

### Resolution conditions

- A condition gets read-only information about the provider: its key, its owner, and its metadata. It returns `true` or `false`.
- If the condition returns `false`, the dependency is not resolved. A required dependency keeps the service `pending`. An optional dependency is `undefined`.
- The condition must be pure and synchronous. A thrown error counts as `false` and goes to the observe stream.
- `explain()` names the provider that the condition rejected.
- The condition checks the provider that the shadowing rule selects. A rejection does not fall back to an ancestor provider.
- The input of a condition is frozen, so injeca calls each condition once for each provider registration and keeps the result.
- `where(optional(key), condition)` and `optional(where(key, condition))` are the same.
- A condition also filters the candidates of a fallback dependency. See [Fallback dependencies](#fallback-dependencies).
- plugin-sdk uses conditions for semantic version ranges. injeca does not know semantic versions.

### Fallback dependencies

- `firstAvailable(...keys)` resolves to the first provider in the list whose effective status is available.
- When the selected provider becomes unavailable, or a provider earlier in the list becomes available, the selection changes.
- A change of the selection is a change of identity. The consumer gets `dependency-change`. With a handler, it can move to the new provider in place. Without one, it rebuilds.
- `firstAvailable` is required, unless it is wrapped in `optional()`. If no provider in the list is available, a required fallback keeps the service `pending`.
- A resolution condition filters the candidates. The selection is the first available candidate that passes its conditions. A rejected candidate is skipped, so the selection falls back to the next candidate.
  - `where(firstAvailable(a, b), condition)` applies the condition to each candidate.
  - `firstAvailable(where(a, condition), b)` applies the condition to `a` only.
  - A candidate with a condition of both forms must pass both. A second `where` on one marker fails with `invalid-argument`.
  - `optional()` combines in any order: `optional(where(firstAvailable(...), c))`, `where(optional(firstAvailable(...)), c)`, and `optional(firstAvailable(where(a, c), b))`.
- When a required fallback does not resolve, `explain()` lists a `rejected-provider` blocker for each rejected candidate.
- An example: a remote LLM plugin is the first choice and a local model is the fallback.

## Services

### Registrations

- Each `provide` call is one registration. Its result is the key with two more members: `withdraw()` and `replace(option)`.
- `withdraw()` and `replace()` from a stale registration resolve `false` and do not change the service. A registration is stale after its own withdrawal, or after a newer `provide` of the same key in the same container.
- A container has one current registration for each key. Before `start()`, a second `provide` of the same name replaces the first registration, as in 0.2. After `start()`, use `replace()`. A second `provide` fails with `duplicate-service`.
- A replacement before `start()` sends a `registration-replaced` record to the observe stream. No hook runs for it.
- `options.perConsumer: true` makes `build` run once for each consumer container. Then the build context has `consumer`, the owner record of that consumer. The instance disposes with the consumer container.
  - The registration itself never builds and stays `pending`. `start()` does not wait for it. Each consumer container gets its own service in that container. Its observe records carry the owner of the consumer container.
  - The `dependsOn` of a consumer service resolves from the container of the registration, not from the consumer container. So it resolves as for a plain registration in that container. A dependency on another `perConsumer` key gets the consumer service of the registration container.
  - A dependent demands the consumer service through each edge kind: required, optional, and `firstAvailable`. A running dependent also demands it when the key registers after the dependent.
  - `replace()` on the registration is atomic for all consumers. Each running consumer service gets a successor that runs `build` and `start`. A successor that completes `start` waits. When every successor waits, one batch swaps the registration and all consumer services. The other consumer services leave and build again on demand.
  - If one successor fails, all successors stop, and `replace()` rejects with that failure. The old registration and its consumer services do not change. A new consumer still builds from the old registration.
  - A consumer service that leaves during the replacement, for example with its container, drops out of the batch. A newer `replace()` or a withdrawal cancels the replacement, and `replace()` resolves `false`.
  - A consumer service in `failed` builds again on a new demand from its container: a new `resolve` call, a new `watch` or `waitFor` subscription, or a dependent that starts to wait for it. A demander gets one new build for each failure, so a waiting dependent cannot cause a retry loop. After the service reaches `running`, each demander gets a new build again after a later failure.
- `options.metadata` is a frozen record that resolution conditions and graph queries can read.
- `options.export: true` exports the registration to the area of the parent container. See [Exported registrations](#exported-registrations).

### Build context

The 0.2 fields stay: `dependsOn`, `name`, and `container`. These fields are new:

| Field | Meaning |
| --- | --- |
| `dependsOn` | The resolved dependencies. A required dependency is its value. An optional dependency is `{ value, status }` or `undefined`. |
| `on(hook, handler)` | Registers a hook. It is valid only while `build` runs. A later call throws `hook-outside-build`. |
| `effect(setup)` | Runs `setup` and stores the returned disposer on the instance. |
| `signal` | An `AbortSignal`. injeca aborts it when a newer target supersedes the build, or when the container is disposed. |
| `setStatus(status, reason?)` | Sets the own status of the instance. The function stays valid after `build` returns. A service that mirrors an outside state, for example a proxy for a remote plugin, keeps it and calls it later. After the instance is disposed, a call has no effect and goes to the observe stream. |
| `instanceId` | The id of the instance that this build creates. |
| `consumer` | The consumer owner record when `perConsumer` is `true`. |

### Invocations

- `invoke({ dependsOn, callback })` registers an invocation. The callback gets the resolved dependencies, as in 0.2, and a second argument with `on`, `effect`, and `signal`.
- The callback runs when the required dependencies are available. Before `start()`, it waits for `start()`.
- When a required dependency gets a new instance, the invocation stops: its `stop` hooks and effects run. Then the callback runs again with the new values.
- `invoke()` returns a handle with `key` and `withdraw()`. Graph queries accept `key`, for example `graph(container).dependencies(handle.key)`.

### resolve

- `resolve(dependsOn)` waits until the dependencies are available and returns their values, as in 0.2. A missing provider makes it wait, not throw. Before `start()`, it builds and starts the services that it needs and their dependencies.
- The values can become stale after a run-time change. Use `resolve` for one-time code. Code that keeps a dependency must be a service or an invocation, so that it converges.
- `resolve(dependsOn, { signal, timeoutMs })` rejects with the abort reason when the signal aborts, and with `wait-timeout` after `timeoutMs` of the container clock. Each rejection removes the hidden resolver of the call. There is no default timeout.
- `peek(container, dependency)` reads a dependency now, without a wait. See [Reading state](#reading-state).

### Phases

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
| `declared` | A transaction reserved the service. Consumers cannot resolve it. |
| `pending` | The service waits for its required dependencies. It runs no code. |
| `conflict` | An exclusive key has more than one declaration. It runs no code. |
| `building` | `build` runs. The instance is not visible. |
| `starting` | The instance is published. The `start` hook runs. |
| `retrying` | A `start` hook returned `requeue`. The service waits for the next attempt. |
| `running` | The instance serves calls. Only this phase has a status. |
| `stopping` | The service waits until its holders release it. Then the `stop` hook and the effect disposers run. |
| `failed` | A build failed, retries ended, a timeout failed, or a hook returned `fail`. A user or Host action moves the service out of `failed`: `start()` again, `stop()` and then `start()`, or `replace()` with a new configuration. A consumer service of a `perConsumer` registration also builds again on a new demand from its container. |
| `withdrawn` | The registration is withdrawn and the instance is disposed. |

| Step | Rule |
| --- | --- |
| `build` | Creates the value. It must not start outside work. |
| `start` | Runs after the instance is published and each required dependency is available. |
| `stop` | Runs before withdrawal. The dependencies are still available. |
| Dispose | Runs the effect disposers of the instance in reverse order. |

### Status

| Status | Meaning | Rule for the provider |
| --- | --- | --- |
| `ready` | The service works at full quality. | — |
| `degraded` | The service works end to end, at lower quality. An example is a TTS fallback voice. | Use `degraded` only when every call still completes. If a call can fail, use `unavailable`. |
| `unavailable` | The instance exists, but calls fail now. An example is a remote device that reconnects. | Use `unavailable` for a temporary condition. For a permanent condition, withdraw the service. |

- The status belongs to the instance, not to the key. A new instance is `ready` after `start`, unless it sets another status.
- `setStatus()` in the build context sets the own status.
- injeca computes the effective status. It is the worst of the own status and the effective status of each required dependency. The order is `ready`, then `degraded`, then `unavailable`.
- The effective status goes down the graph. If `airi.llm` is `unavailable`, each service that requires it is `unavailable`, and each service that requires those services is `unavailable` too.
- An optional dependency does not change the effective status. If a service has lower quality without it, the service sets its own status to `degraded` in a hook.
- A service can make its effective status worse than its dependencies. It cannot make it better. If a service works without a dependency, declare that dependency as optional.
- `ready` and `degraded` count as available. `unavailable` does not. All checks use the effective status.
- A running dependent is not stopped or rebuilt when a dependency becomes `unavailable`. The instance is the same. The effective status of the dependent changes, and the dependent gets a `dependency-status-change` call if it has a handler.
- Each change of an effective status goes to the observe stream with its cause. An example: "`voice.speech` is `unavailable` because `airi.llm` is `unavailable`".
- A status reason can carry a cause chain: `setStatus('unavailable', { reason, cause })`. A cause is `{ key, owner, status, reason, cause? }`. A remote plugin uses it to report a cause inside the plugin, for example `go-ai-gateway/fs-log-store`. `explain()` follows the chain across the bridge.

### Atomic replacement

A withdrawal followed by a new `provide` leaves a gap with no provider. During the gap, all dependents stop. Atomic replacement has no gap.

- `replace(option)` on the result of `provide` replaces the instance of a service. In a transaction, `tx.replace(key, option)` does the same at commit.
- The status of the old instance has no effect. A `ready`, `degraded`, or `unavailable` instance can be replaced. Replacement is the usual fix for an `unavailable` provider.
- The old instance stays published with its status while the new instance runs `build` and `start`.
- The swap occurs only after the new instance completes `start`. If the new `build` or `start` fails, the old instance does not change. The failure goes to the observe stream.
- The swap is one batch. After it, the service has a new `instanceId`. Dependents follow the rule for a replaced required dependency in [dependency-change](#dependency-change).
- For a `perConsumer` registration, the swap of all consumer services is one batch. See [Registrations](#registrations).
- The old instance runs `stop` and dispose only after each holder releases it. A holder that calls an `unavailable` old instance gets the failure that `unavailable` means.
- A dependent without a handler rebuilds without a gap too. See [Rebuild without a gap](#rebuild-without-a-gap). So a replacement deep in the graph changes the identity of each service above it, but it does not withdraw them.
- While the swap waits, `explain()` of the service has `replacement`: the explanation of the new instance, with its phase and blockers.
- A service in `stopping` cannot be replaced. The call fails with `replace-while-stopping`. Wait until the service stops, then call `provide`.
- `replace()` resolves `true` after the swap. It resolves `false` for a stale registration, and when a newer `replace()` or a withdrawal supersedes it. It rejects with the build or start error. It rejects with `replace-while-stopping` when the container stops before the swap.
- A service without a serving instance (`pending`, `conflict`, `failed`, `building`, `starting`, or `retrying`) has no old instance to keep. The new registration takes the slot at once.
- An option without `metadata`, `maxAttempts`, `timeouts`, or `onTimeout` keeps that value of the registration. `perConsumer` does not change.

### Transactions

```ts
const tx = transaction(container)
tx.declare(statusKitKey, { dependsOn: { character: characterKey } })
tx.provide(statusKitKey, { build: () => statusKit })
await tx.commit()
```

- `tx.declare(key, { dependsOn })` adds a declared service. Graph queries can see it. Consumers cannot resolve it.
- A `tx.declare` or a `tx.provide` reserves the key until the commit or the abort. In the same container, a `provide`, or a `tx.declare` or `tx.provide` of another transaction, fails with `duplicate-service`.
- For an exclusive key, the reservation also counts as a declaration in the resolution area. A provider of the key in another container of the area goes to `conflict` and runs no code. After an abort, it converges. After the commit, the published service and that provider are both in `conflict`. This follows [Exclusive keys](#exclusive-keys): a conflict is a phase, not an error, so injeca does not throw for another container.
- `withdraw()` on the result of `tx.provide` before the commit removes the provide from the transaction and resolves `true`. A declaration of the key stays. So the commit fails with `transaction-incomplete`, unless the declaration is optional. During the commit, `withdraw()` waits for the commit, then withdraws the published service.
- `tx.provide(key, options)` fills a declared service, or adds a new service.
- `tx.commit()` builds the services of the transaction in dependency order. A service in a transaction can depend on a built service of the same transaction.
- A service whose required dependencies are not available goes to `pending` at commit. This is not a failure.
- If all builds succeed, `commit()` publishes all services in one batch. Then it runs the `start` hooks.
- If one build fails, `commit()` disposes the built services, removes the declared services, and rejects. No `start` hook runs.
- `tx.abort()` removes all declared services and built services of the transaction.
- A commit fails with `transaction-incomplete` if a declared service has no `provide`, unless the declaration is optional.
- Container disposal during a pending transaction aborts the transaction. A build that settles after the abort cannot publish.
- `commit()` resolves after the publish. It does not wait for the `start` hooks. They run in dependency order, so a service starts after the services of the same transaction that it requires.
- In a container that is not started, `commit()` builds nothing and publishes all services as `pending`. `start()` builds them.
- `tx.provide` without `dependsOn` uses the edges of `tx.declare`. A second `tx.provide` or `tx.replace` of one key fails with `duplicate-service`.
- At the commit, `tx.provide` of a key that a started container already has fails with `duplicate-service`. `tx.replace` of a key without a current registration fails with `stale-registration`.
- After a disposal, `commit()` rejects with `build-after-dispose`. After `tx.abort()`, it rejects with `transaction-incomplete`.

## Convergence

### Serial transitions

These rules come from Cordis `fiber.ts`:

- Each service runs one transition at a time: build, start, stop, dispose, or a hook.
- If the target changes during a transition, injeca does not interrupt it. When the transition ends, injeca compares the result with the latest target and continues toward it.
  - A build that ends after its dependency is withdrawn is discarded at once.
  - A stop that ends after the dependency returns is followed by a build.
- A provider waits until all its holders release it. Then it runs its own `stop` and dispose. Holders can use the provider during their own teardown.

### dependency-change

The identity of a dependency changed: it was replaced, withdrawn, or it appeared.

| Change | No handler | With a handler |
| --- | --- | --- |
| A required dependency is replaced | Rebuild | Call the handler |
| A required dependency is withdrawn | Stop | Stop. The handler gets a notice only. Its return value is ignored. |
| An optional dependency appears, disappears, or is replaced | Rebuild | Call the handler |

A rebuild of a running service, for this table or for `decide.rebuild()`, has no gap when the old instance can keep serving. See [Rebuild without a gap](#rebuild-without-a-gap).

### Rebuild without a gap

A rebuild is make-before-break. The old instance keeps serving while a successor builds and starts. Then one batch swaps them, as for `replace()`.

- The successor has the options of the service. It builds against the current dependencies and runs `start`. Its phases go to the observe stream.
- The old instance keeps its bindings and its status. A bound provider instance stays usable until its last holder releases it, so the old instance keeps working.
- After the successor completes `start`, one batch publishes it and removes the old service. The old instance goes to `stopping` with the decision `rebuild` and its reason. It runs `stop` and dispose after its holders release it.
- The dependents of the service see an identity change and get `dependency-change`. They do not see a withdrawal. A dependent without a handler rebuilds without a gap in the same way. So a change deep in the graph moves up without a gap.
- The successor keeps the place of the service in registration order.
- If the successor fails, the old instance stops, and the service goes to `failed` with that error. This is the same final state as a failed build after a stop.
- If a dependency changes again during the build of the successor, injeca discards the successor and starts a new one.
- A `replace()` or a withdrawal of the registration cancels the rebuild. A pending `replace()` or `tx.replace` takes precedence over a rebuild: the old instance serves until that replacement ends.

The rule for the old instance: it can keep serving when these conditions are all true. Otherwise the service stops first and builds again from `pending`, as in 0.3.0.

1. The service has a key. An invocation has no dependents, so it stops first, then runs again. See [Invocations](#invocations).
2. Each dependency that the old instance is bound to still resolves, maybe to a new instance. A withdrawn dependency, required or optional, leaves nothing to build against.
3. The container is not in disposal.

A required dependency that is withdrawn stops the service at once, as before. A stop or a disposal of the container cancels the successor.

### dependency-status-change

The identity is the same. The effective status of a dependency changed.

| Change | No handler | With a handler |
| --- | --- | --- |
| A dependency changes between `ready`, `degraded`, and `unavailable` | No action | Call the handler |

### Handler input

Both handlers get two values:

- `deps`: the current snapshot of all dependencies, with the `instanceId` and the effective status of each one.
- `changes`: the difference between the last handled snapshot and the current snapshot. Each change has `key`, `from`, and `to`.

The handler must decide from the current snapshot. It must not depend on one change only. This is the level-triggered rule of Kubernetes controllers.

## Decisions

### Hook context

Each hook handler gets a hook context. The context of an invocation callback has the same hooks.

| Field | Hooks | Meaning |
| --- | --- | --- |
| `decide` | All | Creates the decisions that this hook allows. See the table below. |
| `attempt` | All | The number of the current run of this hook for this instance. The first run is `1`. A requeue adds one. |
| `previous` | All | The last decision of this hook for this instance, or `undefined`. |
| `signal` | All | Aborts when a newer target supersedes this run, or when the instance is disposed. |
| `dependsOn` | `dependency-change`, `dependency-status-change` | The current snapshot. See [Handler input](#handler-input). |
| `changes` | `dependency-change`, `dependency-status-change` | The difference to the last handled snapshot. |

### decide

```ts
decide.handled({ reason? })
decide.rebuild({ reason? })
decide.requeue({ after?, backoff?, maxAttempts?, reason? })
decide.stop({ reason? })
decide.fail(error, { reason? })
```

| Hook | Methods on `decide` | `undefined` means |
| --- | --- | --- |
| `start` | `handled`, `requeue`, `stop`, `fail` | `handled` |
| `stop` | `handled`, `fail` | `handled` |
| `dependency-change` | All | The default in [dependency-change](#dependency-change) |
| `dependency-status-change` | All | No action |

- The type of `decide` allows only the methods of its hook. A wrong method is a type error, not a run-time error.
- The return type of a hook is `unknown`, so the shorthand `on('start', () => app.listen(port))` type-checks. A decision from another run fails at run time.
- Each decision is frozen. It carries the fields that the caller gives, and these fields that injeca fills from the context: `service`, `instanceId`, `hook`, `attempt`, and `issuedAt` from the container clock.
- A decision is bound to the run that created it. A value that is not a decision, for example the result of `app.listen()`, counts as `undefined`. A decision from another run, another hook, or another instance fails with `invalid-decision`.
- A run that a newer target superseded can still return. injeca ignores its decision and records it in the observe stream.
- injeca can add fields to a `Decision` later.
- Each decision goes to the observe stream.
- A helper function outside a hook gets `decide` as an argument. Tests use a test helper that creates a hook context.

### Requeue

- `after` sets a fixed delay in milliseconds. When a decision has `after` and `backoff`, `after` wins.
- `backoff: { kind: 'exponential', initial, max, jitter? }` sets an exponential delay. The caller gives all values. The delay is `initial * 2 ** (attempt - 1)`, and at most `max`.
- `jitter` is a fraction from 0 to 1. The delay becomes a random value between `delay * (1 - jitter)` and `delay`. The random source is `createContainer({ random })` of the root container. It defaults to `Math.random`. Tests inject it, so the delays are deterministic.
- `maxAttempts` on the decision, the service, or the container limits the attempts. Without a limit, the requeue continues until the dependency or the container changes.
- A `maxAttempts` on the decision overrides the `provide` option. The `provide` option overrides the `createContainer` option. A container without a value uses the value of its nearest ancestor that has one.
- The attempt count is for each hook of each instance. A run that returns `requeue` at attempt `maxAttempts` ends the retries. So `maxAttempts: 3` allows three runs.
- A requeued run reads the latest snapshot.
- Changes that arrive while a run waits merge into that run. A service never has more than one waiting run.
- A requeue cannot keep a service alive. If a required dependency is withdrawn during any wait, the service cancels the wait and stops at once.
- A `start` requeue keeps the instance. It runs `start` again, not `build`. The service is `retrying` and not available. It still holds its dependencies.
- With more than one `start` handler, the next attempt runs the handler that requeued, then the handlers after it. The handlers before it do not run again.
- A dependency hook requeue keeps the service `running` with its current bindings.
- A requeue for a replaced required dependency delays the release of the old instance. Set `maxAttempts` for this case.
- When attempts end, a running service stops first. Then it goes to `failed` with the last reason.

### Timeouts

- `start` and `stop` wait until they settle, unless the service or the container sets a timeout.
- A service sets `timeouts: { start, stop }` in its `provide` options. Container options can set values for all services. A service value overrides a container value, field by field. A container without a value uses the value of its nearest ancestor that has one.
- The `start` timeout is for all `start` handlers of one attempt. The `stop` timeout is for all `stop` handlers and effect disposers of one instance.
- When a timeout passes, injeca records a `timeout` record in the observe stream. Then it applies the `onTimeout` decision of the service or the container. Without one, the result is `fail` with a `hook-timeout` error.
- `onTimeout(context)` is a synchronous function. `context.hook` is `'start'` or `'stop'`, and `context.decide` has the methods of that hook. A value that is not a decision gives `fail`.
- At a `start` timeout, the hook run signal aborts. The handlers after the stuck handler do not run. A decision that the stuck handler returns later is ignored and recorded.
- When `stop()`, `dispose()`, a withdrawal, or a lost dependency aborts a `start` hook run, injeca does not wait for the handler in progress. The `stop` hooks and effects run at once, and the handlers after it do not run. A decision that the handler returns later is ignored and recorded. A configured `stop` timeout still applies to the `stop` hooks.
- At a `stop` timeout, injeca stops waiting for the stuck callback. It still calls the remaining `stop` handlers and effect disposers, but it does not wait for them.
- A `stop` without a timeout can block a container disposal. The caller that creates the service is responsible for this. A timeout also ends a cleanup that awaits the disposal of its own container. Then the disposal continues and rejects with the `hook-timeout` error.

## Reading state

### Subscriptions

- `watch(container, key, callback)` sends the current phase and effective status at once, then each change. It returns a disposer. The container owns the subscription.
- `waitFor(container, key, { status?, timeoutMs?, signal? })` resolves when the key is available, or has the given status. It rejects on a timeout or an abort. It has no built-in timeout.
- `waitFor` rejects with `service-failed` when the service is in `failed`, or when it waits for a required provider in `failed`, directly or through pending providers. This is the same rule as for `resolve`. The error has `key`, and its `cause` is the failure.
- For a `perConsumer` key, `watch` and `waitFor` demand the consumer service of the container, as `resolve` does. So they report the real availability for that container, also before `start()`. The demand ends with the subscription, or with `stop()`. After a rebuild or a replacement, the demand moves to the new consumer service.
- injeca delivers changes for one key in order. An earlier `withdrawn` never arrives after a later `running`.
- A callback error does not stop a transition or the other callbacks. injeca records the error in the observe stream.
- injeca does not call a callback after its container is disposed.

### Observe stream

- `observe(container, callback)` is a read-only view of all transitions in the container. It replays the current state of all services at once.
- Each record has the key, the owner, the `instanceId`, the from and to phase or status, the decision kind, and the reason.
- A `registration-replaced` record tells that a second `provide` before `start()` replaced a registration. Its reason names the replacement.
- A `timeout` record tells that a `start` or `stop` hook did not settle before its timeout. It has the hook, the timeout, and the attempt. A `decision` record with the `onTimeout` decision follows it.
- An inspector or a trace exporter uses this stream. A consumer can send it to another process with eventa.

### Graph queries

Graph queries are pure reads. They never change state.

| Query | Result |
| --- | --- |
| `graph(container).services()` | All services, with the declared services |
| `graph(container).dependencies(key)` and `graph(container).dependents(key)` | Direct edges |
| `graph(container).order(keys?)` | Topological order |
| `graph(container).cycles()` | All cycles |
| `graph(container).impact(change)` | The services that a proposed change stops or rebuilds |
| `graph(container).explain(key)` | Why a service is not `running`: missing, conflicting, rejected, or unavailable dependencies, or a `start` requeue. A key without a service gives `phase: undefined` and a `missing-provider` blocker. A service with a replacement in progress has `replacement`, the explanation of the new instance. |

`peek(container, dependency)` is a pure read too. It does not demand, build, or start a service. It accepts a key, `where(key, condition)`, or `firstAvailable(...)`, and resolves as for a consumer in the container. The result is one of these:

| `kind` | Meaning |
| --- | --- |
| `resolved` | A running provider serves the key. The result has `value`, `status` (`ready` or `degraded`), and `instanceId`. |
| `unavailable` | A running provider has the effective status `unavailable`. The result has `reason` and `cause`. |
| `not-running` | A provider exists, but it does not run. The result has `phase`, and `error` for a `failed` provider. A `perConsumer` key is `pending` until something demands its service for the container. |
| `rejected` | A resolution condition rejected the provider. |
| `conflict` | The exclusive key has more than one declaration. The result lists the `owners`. |
| `missing` | No provider exists. |

A user interface can preview an action before the user confirms it. An example: "Disabling Y also stops X, A, and B." For this, `graph(container).impact()` runs on a copy of the graph with the proposed change. The copy does not change the real graph. No action requires a preview.

- The queries cover the container and its descendants. A key resolves as for a consumer in the container, with the exports of the child containers at each level. A key that only a descendant has resolves to the first such service.
- `order()` keeps the members of one cycle together, in registration order.
- A change for `impact()` is `{ kind: 'withdraw', key }`, `{ kind: 'replace', key }`, or `{ kind: 'dispose', container }`. The result has `stopped`, `rebuilt`, and `notified`. `notified` lists the dependents with a `dependency-change` handler, because the handler decides. An ancestor provider that serves counts as an alternative, so its dependents rebuild and do not stop.

### Listener registry

injeca does not dispatch events. It gives consumers a place to store listeners that a container owns:

- `listen(container, eventKey, handler, metadata?)` stores a listener. The container owns it.
- `listeners(container, eventKey)` returns the current listeners, with owner and metadata. Metadata examples are priority, timeout, and failure policy.
- An event key is any object with a string `id`. eventa definitions have this shape. injeca does not import eventa.
- `listen()` returns a function that removes the listener. `listeners()` covers the container and its descendants, in registration order.

The consumer defines the rules that run these listeners. For example, the AIRI harness combines gate decisions, runs transform hooks in a declared order, and collects inject hooks in parallel.

## Errors

- All errors are typed classes with a stable `code`: `duplicate-service`, `stale-registration`, `invalid-decision`, `build-after-dispose`, `hook-outside-build`, `transaction-incomplete`, `reentrant-dispose`, `replace-while-stopping`, `service-failed`, `start-timeout`, `wait-timeout`, `hook-timeout`, `invalid-argument`.
- `waitFor` and `resolve` with `timeoutMs` reject with `wait-timeout`.
- Read caller-owned properties once, inside a narrow `try`. A read failure becomes a typed error.
- A `provide` with an `export` option that is not a boolean throws `invalid-argument`.

## Implementation

The implementation has two layers. The interactive model uses the same split.

### Derivation: alien-signals

`alien-signals` owns change tracking and notification.

- `dependsOn` declares the edges. Signals do not discover edges from usage.
- Structural and execution state are signals: presence, phase, own status, `instanceId`, held bindings, and old instances.
- Derived values are computed values: the providers of each key, the resolution of each declared edge, conflict, the effective status and its cause, the dependency snapshot, and the holders of each instance.
- A commit, an atomic replacement, and a container disposal write their signals in one `startBatch` and `endBatch`. Dependents see one consistent change.
- Each service has one effect. It reads the derived values of the service and only marks the service dirty. It runs no business logic and no async work.
- `watch` and `observe` are effects. User callbacks run with tracking paused (`setActiveSub(undefined)`) and inside a `try`.
- Each container owns an `effectScope`. Container disposal disposes its computed values and effects.
- Signal types do not appear in the public API.

### Source layout

`packages/injeca/src` has these directories:

| Directory | Content |
| --- | --- |
| Root | `index.ts` (public entry), `scoped.ts` (functions that take a container), `global.ts` (the global `injeca` object) |
| `primitives/` | The public composition primitives: `provide`, `invoke`, `resolve`, `start` and `stop`, keys, containers, and decisions |
| `queries/` | Read-only functions: `watch`, `waitFor`, `observe`, `peek`, the graph queries, and `listeners` |
| `diagnostics/` | Errors, explanations, and the logger |
| `types/` | Public types, by area |
| `graph/` | `graph.ts` (the data model of the graph: the node types, `DependencyEdge`, `Resolution`, `StatusValue`, `Runtime`, `Reconciler`, and `Observer`), status, and observers |
| `graph/nodes/` | The functions for each node kind: `container`, `service`, `edge`, `registration`, `reservation` (the key reservation of a transaction), and `consumer` (the services of a `perConsumer` registration), with `definition` (the options of one registration). The types are in `graph.ts`, because they refer to each other |
| `graph/resolvers/` | Edge resolution. `resolvers.ts` has the queries on a resolution and the shadowing rule. `plain.ts` and `fallback.ts` resolve each edge kind. `exclusive.ts` has the conflicts. `exports.ts` has the exports of each container and the area of a registration. `condition.ts` runs the resolution conditions |
| `reconciler/` | The execution layer. `reconciler.ts` has the queue and the drain. Each transition has one file |
| `helpers/` | Internal building blocks: signals, the delivery queue, the cleanup context, the clock, and small utilities |
| `testing/` | The `injeca/testing` entry (`testing.ts`) and test helpers |

The main module of a directory is `<dir>/<dir>.ts`, for example `reconciler/reconciler.ts`. An `index.ts` file only re-exports, for example `types/index.ts` and `graph/nodes/index.ts`.

Tests are next to the module that they cover. A reconciler test is next to its transition, for example `reconciler/build.test.ts`.

The transitions get the service and the instance as arguments. They read the shared state from `service.container.runtime`: the clock, the cleanup context, the instance ids, and the reconciler.

### Execution: the reconciler

The reconciler owns async work.

- A work queue holds dirty services. A service is in the queue at most once.
- The reconciler runs one transition at a time for each service. It reads the latest derived values, then starts build, start, stop, or a hook.
- A hook gets `changes` as the difference between the last handled snapshot and the current snapshot. The reconciler does not store individual events.
- `requeue` sets a timer. When the timer ends, the service goes back to the queue.
- The `signal` in the build context cancels async work that a newer target supersedes.
- The clock is injectable, so that tests can control time.

## Delivery

Each step is one pull request in `moeru-ai/injeca` with its tests. The 0.2 tests must pass at each step without changes, except the tests of `lifecycle`.

Status: steps 1 to 5 are done. Only the publish of version 0.3.0 remains. The maintainer releases it with `bumpp` after the merge. Step 6 is the next work.

1. Done. Core: the new engine under the 0.2 API. Keys with `withdraw()`, `defineKey`, `optional`, the build context (`on('start')`, `on('stop')`, `effect`, `signal`), invocations, `resolve`, `start`, `stop`, child containers, `dispose`, decisions, and errors. The `lifecycle` key is removed.
2. Done. Convergence: run-time `provide` and withdrawal, epochs, holder waits, `dependency-change`, status and effective status, `setStatus` after `build`, cause chains, `firstAvailable`, `dependency-status-change`, `watch`, `waitFor`, and `observe`.
3. Done. Composition: transactions, atomic replacement, exclusive keys, resolution conditions, `perConsumer`, key isolation, graph queries, and the listener registry.
4. Done. Retries: requeue, backoff, `maxAttempts`, and timeouts.
5. Done, except the publish. Release: the README, the injeca skill, and version 0.3.0.
5a. Done in 0.3.1. Fixes from the plugin-sdk migration study: an atomic `perConsumer` replacement, demand and failure rules for `watch` and `waitFor`, `withdraw()` before a commit, key reservation, no wait for an aborted `start` hook, `peek` and bounded `resolve`, retries of failed consumer services, children-first disposal, and invocation keys.
5b. Exported registrations: `provide(child, key, { export: true })` and `tx.provide` with `export` make a registration a candidate in the area of the parent container, with exclusive conflicts in that area. See [Exported registrations](#exported-registrations).
5c. Fixes from the plugin-sdk move to injeca. See [Rebuild without a gap](#rebuild-without-a-gap), [Fallback dependencies](#fallback-dependencies), and [Registrations](#registrations).
  - The `dependsOn` of a `perConsumer` consumer service resolves from the registration container. Before, it resolved from the consumer container.
  - `where()` accepts a `firstAvailable()` marker, and `firstAvailable()` accepts `where()` markers. The condition filters the candidates.
  - A rebuild of a running service is make-before-break. Before, it was stop-then-build, so a replacement deep in the graph withdrew the services above it for a moment.
  - An optional or a fallback edge of a running dependent demands the consumer service of a `perConsumer` key that registers later.
  - `explain()` has `replacement` for a service with a replacement in progress.
  - One existing assertion changed: `where(firstAvailable('a', 'b'), condition)` threw `invalid-argument`, and now it returns a fallback marker. The other tests pass without changes.
6. Next. Bridge: the `@injeca/bridge` package in `packages/bridge` connects an eventa channel to a child container. It has its own design document. See [Remote plugins](#remote-plugins). Transport packages that open a channel and report its state as a service use the name `@injeca/channel-<transport>`, for example `@injeca/channel-websocket`.

After the release, one AIRI pull request migrates the `lifecycle` callers. See [Migration of AIRI callers](#migration-of-airi-callers). An experiment with main-process hot reload in `stage-tamagotchi` can follow.

## Tests

Each rule in this document needs a test. These cases are required:

1. A stale registration cannot withdraw or replace a newer service.
2. A failed transaction build publishes nothing and runs no `start` hook.
3. Container disposal during a pending transaction aborts it. A late build cannot publish.
4. A provider waits for its holders to release it before its own `stop` runs.
5. A dependency that is withdrawn during a build discards the build after it ends.
6. A dependency that returns during a stop rebuilds the service after the stop ends.
7. `watch` replays the current state, and delivers changes in order.
8. Many changes during a waiting requeue cause one run with the latest snapshot.
9. A requeue that reaches `maxAttempts` moves the service to `failed`. A requeue without `maxAttempts` keeps retrying.
10. `on` after `build` returns throws `hook-outside-build`.
11. A value that is not a decision counts as `undefined`, and the hook takes its default. Examples are a plain object, a server object, and a promise that resolves to a number. A decision from another run, another hook, or another instance throws `invalid-decision`. A superseded run's decision is ignored and recorded.
12. A re-entrant dispose from the synchronous part of a cleanup rejects. An outside caller gets the same promise.
13. A `perConsumer` service builds once for each consumer container and disposes with that container.
14. Two declarations of an exclusive key put both services in `conflict`, in either order.
15. A service leaves `conflict` when the other declaration is removed, and then converges.
16. A failed resolution condition keeps a required dependent `pending`, and `explain` names the rejected provider.
17. An impact query on a proposed copy reports the stopped services and does not change the real graph.
18. A dependency that becomes `unavailable` does not stop or rebuild a running dependent. A pending dependent does not start.
19. A status change without a `dependency-status-change` handler causes no action.
20. A `start` without a configured timeout waits until it settles.
21. An `unavailable` required dependency makes each dependent, and their dependents, `unavailable` without a stop or a rebuild.
22. An `unavailable` optional dependency does not change the effective status of the dependent.
23. A service cannot report an effective status better than its required dependencies.
24. An `unavailable` service can be replaced. The new instance is `ready` after `start`, and its dependents return to `ready`.
25. A failed `start` of a new instance keeps the old instance and its status.
26. The old instance disposes only after the last holder moves to the new instance.
27. `replace` on a service in `stopping` fails with `replace-while-stopping`.
28. A required dependency that is withdrawn during a `start` requeue cancels the retry and stops the service.
29. A dependency hook requeue that reaches `maxAttempts` stops a running service, then moves it to `failed`.
30. A batch that publishes many services causes one notification for each dependent, not one for each service.
31. The 0.2 test suite passes without changes, except the tests of `lifecycle`.
32. A `provide` after `start()` builds and starts the new service when its dependencies are available.
33. An invocation runs again with the new values when a required dependency gets a new instance.
34. A dependent of a key from `defineKey` stays `pending` until a provider registers, then starts.
35. Types: `provide` by name infers the key type from `build`. `dependsOn` infers each value. An optional dependency is `{ value, status } | undefined`. A wrong `build` result for a `defineKey` key is a type error.
36. `setStatus` after `build` changes the own status and the effective status of dependents. After disposal, it has no effect.
37. A cause chain from `setStatus` appears in `explain()` of a dependent.
38. `firstAvailable` selects the first available provider, moves to the fallback when the first becomes unavailable, and moves back when it returns.
39. Types: `decide` in a `stop` hook has no `requeue`, `rebuild`, or `stop`. A decision carries `service`, `instanceId`, `hook`, `attempt`, and `issuedAt`.
40. A `perConsumer` replacement that fails for one consumer changes no consumer. A successful one swaps all consumers in one batch.
41. `watch` and `waitFor` of a `perConsumer` key demand the consumer service, and the demand ends with the subscription.
42. `waitFor` of a failed service, or of a service that waits for a failed provider, rejects with `service-failed`.
43. `withdraw()` of a `tx.provide` before the commit removes the provide. A declared key without a provide fails the commit.
44. A declared key fails another `provide` in the same container, and puts an exclusive provider in another container in `conflict` until the abort.
45. `stop()` and `dispose()` do not wait for an aborted `start` hook.
46. `resolve` with `timeoutMs` or `signal` rejects and removes its hidden resolver. `peek` does not create a service.
47. A failed consumer service builds again on a new demand, once for each demander.
48. `dispose(parent)` disposes the child containers first, in reverse creation order.
49. `effect` after the disposal started runs its disposer at once. `invoke` returns a `key` that graph queries accept.
50. An exported registration resolves for the parent and for the siblings. Without `export`, it stays invisible to them. An export goes exactly one level up.
51. At one level, the own registration of the container comes first. An export shadows a farther ancestor only while it runs, without a gap.
52. Two sibling exports of one exclusive key conflict in either order. A parent registration and a child export of one exclusive key conflict.
53. An isolated key hides the exports of the siblings, but not the exports of the own children.
54. A `perConsumer` export builds one instance in each consumer container. A `tx.provide` with `export` reserves an exclusive key in the parent area until the commit or the abort.
55. A cleanup that awaits the disposal of its own container after an `await` is not detected as re-entrant. A configured `stop` timeout ends the wait.
56. A `perConsumer` registration, exported or not, resolves its dependencies from its own container. The build context keeps `consumer`.
57. `where(firstAvailable(...), condition)` and `firstAvailable(where(key, condition), ...)` select the first available candidate that passes. `optional` combines in any order. `explain()` names each rejected candidate.
58. A replacement of a leaf rebuilds an intermediate service make-before-break. Its dependent gets `dependency-change` from the old instance to the new one, and never stops. A withdrawn bound dependency still stops first. A failed successor fails the service. An invocation stops, then runs again.
59. An optional or a `firstAvailable` edge to a `perConsumer` key that registers after the dependent demands the consumer service.
60. `explain()` of a service with a pending `replace()` has `replacement` with the phase and the blockers of the new instance.

## Appendix: plugin-sdk

plugin-sdk is a reference, not a source of requirements. After 0.3, plugin-sdk can use these injeca capabilities in place of its own code:

| plugin-sdk today | injeca 0.3 |
| --- | --- |
| `KitProviderRegistry` slots and generations | Services, registrations, instances, and epochs |
| Host source tokens and leases | Registrations with `withdraw()` |
| `beginExtensionSession`, reserve and commit | `transaction(container)`, `declare`, `commit` |
| `DependencyService` states and `waitFor` | Phases, effective status, `watch`, `waitFor` |
| `ctx.kits.watch` | `watch(container, key, callback)` |
| `HostClientFactory(runtime)` | `perConsumer: true` and `consumer` in the build context |
| `DisposableStore` and the session cleanup chain | Container effects and `dispose(container)` |
| `ResourceService` | `provide` with a value or a lazy `build` |
| Activation Planner graph, order, and cycles | `graph(container).*` queries. AIRI removes the Planner. |
| Planner `duplicate-extension-provider` and `host-kit-id-conflict` | Exclusive keys and `conflict`. Sibling Extension containers export their Kits, so their exclusive keys meet in the host area. |
| Planner `missing-required-kit`, `incompatible-kit-version`, `dependency-cycle` | `pending` services, resolution conditions, `graph(container).explain()`, `graph(container).cycles()` |

These parts are Kit policy and stay in plugin-sdk: Kit Contracts, exact provider versions and consumer ranges, exposure policy, permissions, Manifest checks at import and install time, user-facing text from `graph(container).explain()`, and Kit routing.

## Migration of AIRI callers

injeca 0.3 removes `lifecycle` and `appHooks`. Change these files in the same pull request as the version bump:

- `apps/stage-tamagotchi/src/main/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/apple-speech-transcription/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/apple-vision/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/channel-server/index.ts`
- `server/apps/api/src/app.ts`
- `server/apps/api/src/libs/redis/stream-consumer.ts`
- `server/apps/auth/src/server.ts`

Replace `dependsOn: { lifecycle }` and `lifecycle.appHooks.onStart/onStop` with `on('start')` and `on('stop')` in `build`. Also update `server/apps/api/README.md` and `server/docs/ai/adr/2026-10-18-account-events-stream.md`, because they describe `lifecycle.appHooks`. Check the other files that import `injeca` for `invoke` and `resolve` callers.

## Follow-up outside injeca

- The AIRI harness ADR and plugin-sdk use the host capability states `announced`, `ready`, `degraded`, and `withdrawn`. Add `unavailable` there, with the same meaning.
- AIRI issue #2507 describes the Activation Planner as Phase 2. Explain its removal there before the plugin-sdk change.
