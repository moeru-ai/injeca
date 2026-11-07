// The cheat sheet: each primitive in one sentence, with a few lines of code from samples.ts (`cheat/<id>`).
// `chapter` is the chapter of the page that shows it, when one does.

export interface CheatCard {
  readonly id: string
  readonly use: string
  readonly text: string
  readonly chapter?: string
}

export interface CheatGroup {
  readonly title: string
  readonly cards: readonly CheatCard[]
}

export const CHEAT: readonly CheatGroup[] = [
  {
    title: 'Register and resolve',
    cards: [
      { id: 'provide', use: 'provide()', text: 'Registers a unit under a key and returns that key with its type.', chapter: 'unit' },
      { id: 'depends-on', use: 'dependsOn', text: 'Declares what a unit needs and passes the values to build.', chapter: 'dependency' },
      { id: 'resolve', use: 'resolve()', text: 'Gets the values of keys for outside code, waiting until they are ready.', chapter: 'unit' },
      { id: 'invoke', use: 'invoke()', text: 'Runs a callback when its dependencies are running, and again when one gets a new instance.' },
    ],
  },
  {
    title: 'Lifecycle',
    cards: [
      { id: 'hooks', use: 'on(\'start\'), on(\'stop\')', text: 'Starts and stops a resource with its instance, in dependency order.', chapter: 'lifecycle' },
      { id: 'requeue', use: 'decide.requeue()', text: 'Retries a failed start hook after a delay, with an optional limit.', chapter: 'retry' },
      { id: 'timeouts', use: 'timeouts, onTimeout', text: 'Limits how long a hook can take and decides what happens on timeout.' },
    ],
  },
  {
    title: 'Changes at run time',
    cards: [
      { id: 'replace', use: 'replace()', text: 'Swaps in a new instance. The old one keeps serving until the new one is ready.', chapter: 'swap' },
      { id: 'withdraw', use: 'withdraw()', text: 'Withdraws a unit. Units that depend on it stop and wait.', chapter: 'swap' },
      { id: 'dependency-change', use: 'on(\'dependency-change\')', text: 'Takes a new dependency in place, without rebuilding the instance.', chapter: 'swap' },
      { id: 'set-status', use: 'setStatus()', text: 'Marks an instance ready, degraded, or unavailable and passes the status to dependents.', chapter: 'status' },
    ],
  },
  {
    title: 'Missing providers',
    cards: [
      { id: 'define-key', use: 'defineKey()', text: 'Creates a typed key before any provider is registered.', chapter: 'late' },
      { id: 'optional', use: 'optional()', text: 'Lets a unit build and run even when a dependency has no provider.', chapter: 'late' },
      { id: 'first-available', use: 'firstAvailable()', text: 'Uses the first provider in a list that is currently running.', chapter: 'late' },
      { id: 'where', use: 'where()', text: 'Accepts only providers that pass a check, for example on version or owner.' },
    ],
  },
  {
    title: 'Plugins and containers',
    cards: [
      { id: 'transaction', use: 'transaction()', text: 'Builds several units together and publishes all of them, or none if one fails.', chapter: 'plugin' },
      { id: 'container', use: 'createContainer({ parent })', text: 'Gives a plugin its own scope. dispose() cleans up everything inside it.', chapter: 'containers' },
      { id: 'isolate', use: 'isolate', text: 'Keeps specified keys in a child container from using parent providers.', chapter: 'containers' },
      { id: 'exclusive', use: 'defineKey(…, { exclusive })', text: 'Allows only one provider for a key. A second provider puts both in conflict.', chapter: 'containers' },
      { id: 'visibility', use: 'visibility: \'parent\'', text: 'Makes a unit of a plugin container visible to its parent and sibling plugins.' },
      { id: 'instances', use: 'instances: \'per-container\'', text: 'Builds a separate instance for each container that uses it.' },
    ],
  },
  {
    title: 'Waiting and watching',
    cards: [
      { id: 'timeout', use: 'timeout(), { signal }', text: 'Stops waiting after a time limit while the units keep running.', chapter: 'cancel' },
      { id: 'watch', use: 'watch(), waitFor()', text: 'Watches or waits for the phase and status of a single unit.' },
      { id: 'observe', use: 'observe()', text: 'Reports every state change in a container, along with its cause.' },
      { id: 'graph', use: 'graph()', text: 'Explains why a unit is waiting and previews what a change will affect.' },
      { id: 'manual-clock', use: 'manualClock()', text: 'Advances time by hand in tests for timeouts and retries.' },
    ],
  },
]
