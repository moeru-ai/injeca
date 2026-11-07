// What injeca handles, in seven pillars, before the chapters teach them. Each pillar names its primitives and links to
// the chapter that runs it, or to the cheat sheet. The icons are MingCute names that vite.config.ts takes into the build.

export interface Feature {
  readonly icon: string
  readonly title: string
  readonly text: string
  readonly primitives: readonly string[]
  /** The id of a chapter, or of the cheat sheet. */
  readonly target: string
  /** A wide card takes two columns. */
  readonly wide?: boolean
}

export const FEATURES: readonly Feature[] = [
  {
    icon: 'key-2-fill',
    title: 'Dependency injection',
    text: 'Declare what each unit needs. injeca builds the graph in order, starts and stops it in order, and passes typed values to each build. No classes, no decorators.',
    primitives: ['provide()', 'dependsOn', 'on(\'start\')'],
    target: 'unit',
    wide: true,
  },
  {
    icon: 'refresh-3-fill',
    title: 'Swap at run time',
    text: 'Replace, add, or withdraw a unit while the app runs. The old instance keeps serving until the new one is ready, so nothing that depends on it stops.',
    primitives: ['replace()', 'withdraw()', 'on(\'dependency-change\')'],
    target: 'swap',
  },
  {
    icon: 'heartbeat-fill',
    title: 'Status awareness',
    text: 'A running instance is ready, degraded, or unavailable. Status changes flow to every unit that depends on it, without a rebuild.',
    primitives: ['setStatus()', 'watch()', 'waitFor()'],
    target: 'status',
  },
  {
    icon: 'layers-fill',
    title: 'Isolated containers',
    text: 'Give each plugin its own container. It sees its parent containers, shares only the units that it makes visible to the parent, and disposing it cleans up everything it owns.',
    primitives: ['createContainer()', 'isolate', 'visibility'],
    target: 'containers',
  },
  {
    icon: 'box-3-fill',
    title: 'Transactions with rollback',
    text: 'Publish a group of units in one step. If any build fails, nothing is published, and the units that already built are disposed.',
    primitives: ['transaction()', 'tx.commit()'],
    target: 'plugin',
  },
  {
    icon: 'search-2-fill',
    title: 'Explain',
    text: 'Every change records its cause. Ask why a unit is waiting, preview what a change will stop or rebuild before you run it, and follow every state change as it happens.',
    primitives: ['graph().explain()', 'graph().impact()', 'observe()'],
    target: 'cheat-sheet',
    wide: true,
  },
  {
    icon: 'flask-fill',
    title: 'Built for testing',
    text: 'Advance the clock by hand to test timeouts and retries, wait until the queue settles, and test a lifecycle hook on its own.',
    primitives: ['manualClock()', 'drained()', 'createHookContext()'],
    target: 'cheat-sheet',
  },
]
