// The chapters of the page. Each one teaches one idea with a small graph, and uses only the ideas before it.
// A chapter has one or more variants: each answers its question with another primitive, and its `run` drives the real
// injeca step by step. samples.ts has the code that a user writes for each variant, and each step names its lines.
// The page draws the frames. The README figures show the variants of a chapter side by side.

import type { Lab, LabEdge } from './lab'

import { defineKey, firstAvailable, optional, provide, start, stop, timeout, transaction } from 'injeca'

export interface ScenarioNode {
  readonly id: string
  /** The column and the row on the grid of the chapter. Halves are fine. */
  readonly x: number
  readonly y: number
}

/** A container drawn around some nodes. */
export interface ScenarioBox {
  readonly label: string
  readonly nodes: readonly string[]
}

export type Tone = 'good' | 'warn' | 'bad'

export interface Variant {
  readonly id: string
  /** The primitive, as a short call. */
  readonly primitive: string
  readonly tone: Tone
  /** What happens, in a few plain words. */
  readonly outcome: string
  readonly summary: string
  /** The step that shows the difference best. The README figure uses it. */
  readonly key: number
  /** The edges of this variant, when they are not the edges of the chapter. */
  readonly edges?: readonly LabEdge[]
  readonly run: (lab: Lab) => Promise<void>
}

export interface Scenario {
  readonly id: string
  /** The short name in the chapter list. */
  readonly nav: string
  /** The primitives that the chapter introduces. */
  readonly primitives: readonly string[]
  readonly title: string
  /** What the reader needs to know before the graph moves. `code` in backticks shows as code. */
  readonly intro: readonly string[]
  /** The question that the variants answer, when the chapter has more than one. */
  readonly question?: string
  /** The name of the file in the code window. */
  readonly file: string
  /** The README section that explains the primitives. */
  readonly section: string
  readonly nodes: readonly ScenarioNode[]
  readonly boxes?: readonly ScenarioBox[]
  readonly edges: readonly LabEdge[]
  readonly variants: readonly Variant[]
}

const value = () => ({})

/** The edges that a variant draws. */
export function edgesOf(scenario: Scenario, variant: Variant): readonly LabEdge[] {
  return variant.edges ?? scenario.edges
}

// Units ---------------------------------------------------------------------------------------------------------------

const unit: Scenario = {
  id: 'unit',
  nav: 'Units',
  primitives: ['provide()', 'start()', 'resolve()'],
  title: 'A unit is a named value',
  intro: [
    '`provide()` registers a unit under a key, here `config`. Nothing runs yet.',
    '`start()` builds it: injeca calls `build` once and caches what it returns. That value is an instance. Other code gets it by its key.',
  ],
  file: 'config.ts',
  section: 'basic-usage',
  nodes: [{ id: 'config', x: 0, y: 0 }],
  edges: [],
  variants: [{
    id: 'main',
    primitive: 'provide()',
    tone: 'good',
    outcome: 'One instance',
    summary: 'config builds once, and its returned value is the instance v1.',
    key: 2,
    run: async (lab) => {
      provide(lab.host, 'config', async () => {
        await lab.gate('config')
        return {}
      })
      await lab.step('provide(): config is registered and waits for start().', { focus: ['config'], note: 'registered', lines: [1] })
      lab.start()
      await lab.step('start(): injeca calls the build function of config.', { focus: ['config'], note: 'build runs', lines: [3] })
      lab.open('config')
      await lab.step('config is running. resolve() returns its instance, v1.', { focus: ['config'], note: 'v1 is ready', lines: [4] })
    },
  }],
}

// Dependencies --------------------------------------------------------------------------------------------------------

const dependency: Scenario = {
  id: 'dependency',
  nav: 'Dependencies',
  primitives: ['dependsOn'],
  title: 'A unit can depend on another unit',
  intro: [
    '`dependsOn` declares what a unit needs. Arrows point from each provider to the unit that uses it.',
    'injeca builds the provider first and passes its value to `build`. Until then, the dependent waits and runs no code. The order of `provide()` calls does not matter.',
  ],
  file: 'server.ts',
  section: 'basic-usage',
  nodes: [{ id: 'config', x: 0, y: 0 }, { id: 'server', x: 1, y: 0 }],
  edges: [{ from: 'server', to: 'config' }],
  variants: [{
    id: 'main',
    primitive: 'dependsOn',
    tone: 'good',
    outcome: 'Provider first',
    summary: 'server waits for config, then builds with its value.',
    key: 0,
    run: async (lab) => {
      let builds = 0
      provide(lab.host, 'server', {
        dependsOn: { config: 'config' },
        build: async () => {
          if (++builds === 1)
            await lab.gate('server')
          return {}
        },
      })
      lab.start()
      await lab.step('server depends on config. config is not registered yet, so server waits.', { focus: ['server'], note: 'waits for config', lines: [1, 2] })
      provide(lab.host, 'config', async () => {
        await lab.gate('config')
        return {}
      })
      await lab.step('provide(\'config\'): config builds first.', { focus: ['config'], note: 'builds first', lines: [6] })
      lab.open('config')
      await lab.step('config is running. Now server builds with the value of config.', { focus: ['server'], note: 'gets config', lines: [3] })
      lab.open('server')
      await lab.step('server is running.', { focus: ['config', 'server'] })
    },
  }],
}

// Start and stop ------------------------------------------------------------------------------------------------------

const lifecycle: Scenario = {
  id: 'lifecycle',
  nav: 'Start and stop',
  primitives: ['on(\'start\')', 'on(\'stop\')', 'stop()'],
  title: 'Each unit starts after what it needs, and stops before it',
  intro: [
    'A build can register hooks: `on(\'start\')` runs when the instance starts, and `on(\'stop\')` runs when it stops.',
    'Start hooks run from providers to the units that use them. On `stop()`, every unit enters stopping, but each provider waits until its dependents finish stopping. So no running unit ever loses a dependency.',
  ],
  file: 'server.ts',
  section: 'lifecycle-in-build',
  nodes: [{ id: 'config', x: 0, y: 0 }, { id: 'server', x: 1, y: 0 }, { id: 'routes', x: 2, y: 0 }],
  edges: [{ from: 'server', to: 'config' }, { from: 'routes', to: 'server' }],
  variants: [{
    id: 'main',
    primitive: 'stop()',
    tone: 'good',
    outcome: 'Dependents stop first',
    summary: 'routes runs its stop hook first, then server, then config.',
    key: 1,
    run: async (lab) => {
      const stopping = (name: string) => ({ on }: { on: (hook: 'stop', handler: () => Promise<void>) => void }) => {
        on('stop', () => lab.gate(`stop-${name}`))
        return {}
      }
      provide(lab.host, 'config', stopping('config'))
      provide(lab.host, 'server', { dependsOn: { config: 'config' }, build: stopping('server') })
      provide(lab.host, 'routes', { dependsOn: { server: 'server' }, build: stopping('routes') })
      lab.start()
      await lab.step('start(): config starts first, then server, then routes.', { lines: [5, 11] })
      lab.track('stop()', stop(lab.host))
      await lab.step('stop(): all three enter stopping. Nothing depends on routes, so its stop hook runs first while server and config wait.', { focus: ['routes'], note: 'stop hook runs', lines: [12] })
      lab.open('stop-routes')
      await lab.step('routes has stopped. Now server closes while config still waits.', { focus: ['server'], note: 'stop hook runs', lines: [6] })
      lab.open('stop-server')
      await lab.step('server has stopped. config stops last.', { focus: ['config'], note: 'stop hook runs', lines: [6] })
      lab.open('stop-config')
      await lab.step('All stopped. The registrations stay, so start() can build them again.', { lines: [12] })
    },
  }],
}

// Swap a provider -----------------------------------------------------------------------------------------------------

function swapGraph(lab: Lab, options: { handler?: boolean, gateSpeech?: boolean } = {}) {
  const tts = provide(lab.host, 'tts', value)
  let builds = 0
  const speech = provide(lab.host, 'speech', {
    dependsOn: { tts },
    build: async ({ on }) => {
      builds++
      if (options.gateSpeech && builds === 2)
        await lab.gate('speech-2')
      if (options.handler)
        on('dependency-change', ({ decide }) => decide.handled())
      return {}
    },
  })
  provide(lab.host, 'app', { dependsOn: { speech }, build: value })
  return tts
}

const swap: Scenario = {
  id: 'swap',
  nav: 'Changes at run time',
  primitives: ['replace()', 'withdraw()', 'on(\'dependency-change\')'],
  title: 'A running unit can change at run time',
  intro: [
    'A new version of tts is ready while the app runs. Each build creates a new instance: v2 after v1.',
    'Watch the bar under each unit: it shows whether the unit can serve at each step.',
  ],
  question: 'How does the app switch to tts v2?',
  file: 'reload.ts',
  section: 'atomic-replacement',
  nodes: [{ id: 'tts', x: 0, y: 0 }, { id: 'speech', x: 1, y: 0 }, { id: 'app', x: 2, y: 0 }],
  edges: [{ from: 'speech', to: 'tts' }, { from: 'app', to: 'speech' }],
  variants: [
    {
      id: 'withdraw',
      primitive: 'withdraw() + provide()',
      tone: 'bad',
      outcome: 'app stops for a while',
      summary: 'Withdrawing tts stops everything that depends on it. Until the new tts runs, app cannot serve.',
      key: 1,
      run: async (lab) => {
        const tts = swapGraph(lab)
        lab.start()
        await lab.step('start(): tts, speech, and app are running.')
        lab.track('withdraw()', tts.withdraw())
        await lab.step('withdraw(): app and speech stop first, then tts is withdrawn. app cannot serve now.', { focus: ['app', 'speech', 'tts'], note: 'stopped', lines: [1] })
        provide(lab.host, 'tts', async () => {
          await lab.gate('tts-2')
          return {}
        })
        await lab.step('provide(): the new tts builds while speech and app wait.', { focus: ['tts'], note: 'v2 builds', lines: [2] })
        lab.open('tts-2')
        await lab.step('tts v2 is running. speech and app build again from the start.', { focus: ['speech', 'app'], note: 'rebuilt' })
      },
    },
    {
      id: 'replace',
      primitive: 'replace()',
      tone: 'good',
      outcome: 'app keeps serving',
      summary: 'tts v1 keeps serving until tts v2 is ready, then swaps in one step. speech and app get new instances the same way, so app never stops.',
      key: 1,
      run: async (lab) => {
        const tts = swapGraph(lab, { gateSpeech: true })
        lab.start()
        await lab.step('start(): tts, speech, and app are running.')
        lab.track('replace()', tts.replace(async () => {
          await lab.gate('tts-2')
          return {}
        }))
        await lab.step('replace(): tts v2 builds alongside v1 while v1 keeps serving speech.', { focus: ['tts'], note: 'v2 builds, v1 serves', lines: [1] })
        lab.open('tts-2')
        await lab.step('tts swaps to v2. speech v2 builds while speech v1 keeps serving app.', { focus: ['speech'], note: 'v1 still serves app' })
        lab.open('speech-2')
        await lab.step('speech swaps, then app. Each old instance stops once nothing uses it.', { focus: ['speech', 'app'], note: 'swapped' })
      },
    },
    {
      id: 'handler',
      primitive: 'replace() + dependency-change',
      tone: 'good',
      outcome: 'speech keeps its instance',
      summary: 'speech has a dependency-change handler. It takes tts v2 in place without rebuilding, so app sees no change.',
      key: 2,
      run: async (lab) => {
        const tts = swapGraph(lab, { handler: true })
        lab.start()
        await lab.step('start(): tts, speech, and app are running.')
        lab.track('replace()', tts.replace(async () => {
          await lab.gate('tts-2')
          return {}
        }))
        await lab.step('replace(): tts v2 builds alongside v1.', { focus: ['tts'], note: 'v2 builds', lines: [7] })
        lab.open('tts-2')
        await lab.step('tts swaps to v2. The handler of speech takes v2 in place: speech stays v1, and app does not change.', { focus: ['speech'], note: 'stays v1', lines: [2, 3, 4] })
      },
    },
  ],
}

// Status --------------------------------------------------------------------------------------------------------------

function statusGraph(lab: Lab) {
  const control: { setStatus?: (status: 'ready' | 'degraded' | 'unavailable', options?: { reason: string }) => void } = {}
  const llm = provide(lab.host, 'llm', {
    build: ({ setStatus }) => {
      control.setStatus = setStatus
      return {}
    },
  })
  const chat = provide(lab.host, 'chat', { dependsOn: { llm }, build: value })
  provide(lab.host, 'notes', { dependsOn: { llm: optional(llm) }, build: value })
  provide(lab.host, 'app', { dependsOn: { chat }, build: value })
  return { llm, control }
}

const status: Scenario = {
  id: 'status',
  nav: 'Status',
  primitives: ['setStatus()'],
  title: 'A running unit can report its status',
  intro: [
    'A running instance is `ready`, `degraded` (still working, at lower quality), or `unavailable` (still there, but calls fail right now).',
    'Status flows down to every unit that depends on it. `notes` uses `llm` as optional, so its status is unaffected.',
  ],
  question: 'The connection of llm drops. What happens to the units that depend on it?',
  file: 'llm.ts',
  section: 'status',
  nodes: [{ id: 'llm', x: 0, y: 0.5 }, { id: 'chat', x: 1, y: 0 }, { id: 'notes', x: 1, y: 1 }, { id: 'app', x: 2, y: 0 }],
  edges: [{ from: 'chat', to: 'llm' }, { from: 'notes', to: 'llm', optional: true }, { from: 'app', to: 'chat' }],
  variants: [
    {
      id: 'unavailable',
      primitive: `setStatus('unavailable')`,
      tone: 'good',
      outcome: 'Same instances, marked unavailable',
      summary: 'chat and app become unavailable with llm, but keep their instances. When llm is ready again, so are they, without a rebuild.',
      key: 1,
      run: async (lab) => {
        const { control } = statusGraph(lab)
        lab.start()
        await lab.step('start(): all units are running and ready.')
        control.setStatus!('unavailable', { reason: 'reconnecting' })
        await lab.step('llm is unavailable. chat and app become unavailable with the same instances, while notes stays ready.', { focus: ['llm', 'chat', 'app'], note: 'unavailable', lines: [3] })
        control.setStatus!('ready')
        await lab.step('llm reconnects. ready status flows back down without a rebuild.', { focus: ['llm', 'chat', 'app'], note: 'ready again', lines: [4] })
      },
    },
    {
      id: 'degraded',
      primitive: `setStatus('degraded')`,
      tone: 'good',
      outcome: 'Still works, lower quality',
      summary: 'degraded means calls still succeed at lower quality. chat and app become degraded too, and keep serving.',
      key: 1,
      run: async (lab) => {
        const { control } = statusGraph(lab)
        lab.start()
        await lab.step('start(): all units are running and ready.')
        control.setStatus!('degraded', { reason: 'fallback model' })
        await lab.step('llm is degraded. chat and app become degraded too, while notes stays ready.', { focus: ['llm', 'chat', 'app'], note: 'degraded', lines: [1] })
        control.setStatus!('ready')
        await lab.step('llm is ready again, and its dependents recover with it.', { focus: ['llm', 'chat', 'app'], note: 'ready again', lines: [2] })
      },
    },
    {
      id: 'withdraw',
      primitive: 'withdraw()',
      tone: 'warn',
      outcome: 'chat and app stop',
      summary: 'Withdrawing llm removes it permanently. chat and app stop and wait for a new provider, while notes rebuilds without llm.',
      key: 1,
      run: async (lab) => {
        const { llm } = statusGraph(lab)
        lab.start()
        await lab.step('start(): all units are running and ready.')
        lab.track('withdraw()', llm.withdraw())
        await lab.step('withdraw(): chat and app stop and wait. notes rebuilds without llm.', { focus: ['chat', 'app', 'notes'], note: 'stops and waits', lines: [1] })
      },
    },
  ],
}

// A key without a provider --------------------------------------------------------------------------------------------

function lateGraph(lab: Lab, kind: 'required' | 'optional' | 'first') {
  const remoteTts = defineKey<object>('remote-tts')
  const localTts = provide(lab.host, 'local-tts', value)
  const tts = kind === 'required' ? remoteTts : kind === 'optional' ? optional(remoteTts) : firstAvailable(remoteTts, localTts)
  const speech = provide(lab.host, 'speech', { dependsOn: { tts }, build: value })
  provide(lab.host, 'app', { dependsOn: { speech }, build: value })
  return remoteTts
}

const late: Scenario = {
  id: 'late',
  nav: 'Missing providers',
  primitives: ['defineKey()', 'optional()', 'firstAvailable()'],
  title: 'A unit can depend on a provider that loads later',
  intro: [
    '`defineKey()` creates a key before any provider exists, so a unit can depend on it now while a plugin provides it later.',
    'The unit chooses what to do in the meantime: wait for it, run without it, or fall back to another provider.',
  ],
  question: 'speech wants remote-tts, whose plugin loads later. What does speech do now?',
  file: 'speech.ts',
  section: 'keys-without-a-provider',
  nodes: [{ id: 'remote-tts', x: 0, y: 0 }, { id: 'local-tts', x: 0, y: 1 }, { id: 'speech', x: 1, y: 0.5 }, { id: 'app', x: 2, y: 0.5 }],
  edges: [{ from: 'speech', to: 'remote-tts' }, { from: 'speech', to: 'local-tts' }, { from: 'app', to: 'speech' }],
  variants: [
    {
      id: 'required',
      primitive: 'defineKey()',
      tone: 'warn',
      outcome: 'Waits for it',
      summary: 'speech and app wait and run no code. When the plugin provides remote-tts, they build and start.',
      key: 0,
      edges: [{ from: 'speech', to: 'remote-tts' }, { from: 'app', to: 'speech' }],
      run: async (lab) => {
        const remoteTts = lateGraph(lab, 'required')
        lab.start()
        await lab.step('start(): remote-tts has no provider yet. speech and app wait and run no code.', { focus: ['speech'], note: 'waits', lines: [1, 2] })
        provide(lab.host, remoteTts, value)
        await lab.step('The plugin provides remote-tts. speech and app build and start.', { focus: ['remote-tts', 'speech', 'app'], note: 'provided', lines: [5] })
      },
    },
    {
      id: 'optional',
      primitive: 'optional()',
      tone: 'good',
      outcome: 'Runs without it',
      summary: 'speech builds right away without a TTS. When remote-tts appears, speech gets a new instance that uses it, and app keeps serving.',
      key: 0,
      edges: [{ from: 'speech', to: 'remote-tts', optional: true }, { from: 'app', to: 'speech' }],
      run: async (lab) => {
        const remoteTts = lateGraph(lab, 'optional')
        lab.start()
        await lab.step('start(): speech builds right away without a TTS, and app starts next.', { focus: ['speech'], note: 'runs without tts', lines: [2, 3] })
        provide(lab.host, remoteTts, value)
        await lab.step('remote-tts is provided. speech and app switch to new instances without stopping.', { focus: ['remote-tts', 'speech'], note: 'v2 uses it' })
      },
    },
    {
      id: 'first',
      primitive: 'firstAvailable()',
      tone: 'good',
      outcome: 'Uses a fallback',
      summary: 'speech uses local-tts until remote-tts is running, then switches to it. If remote-tts is withdrawn, speech switches back.',
      key: 1,
      run: async (lab) => {
        const remoteTts = lateGraph(lab, 'first')
        lab.start()
        await lab.step('start(): remote-tts has no provider, so speech uses local-tts.', { focus: ['local-tts', 'speech'], note: 'uses local-tts', lines: [2] })
        const remote = provide(lab.host, remoteTts, value)
        await lab.step('remote-tts is running. It comes first in the list, so speech switches to it.', { focus: ['remote-tts', 'speech'], note: 'switches to remote' })
        lab.track('withdraw()', remote.withdraw())
        await lab.step('remote-tts is withdrawn. speech switches back to local-tts.', { focus: ['local-tts', 'speech'], note: 'back to local' })
      },
    },
  ],
}

// Retries -------------------------------------------------------------------------------------------------------------

function retryGraph(lab: Lab, fail: (decide: any) => unknown) {
  let attempts = 0
  const device = provide(lab.host, 'device', {
    build: ({ on }) => {
      on('start', ({ decide }) => {
        attempts++
        if (attempts < 3)
          return fail(decide)
      })
      return {}
    },
  })
  const monitor = provide(lab.host, 'monitor', { dependsOn: { device }, build: value })
  provide(lab.host, 'app', { dependsOn: { monitor }, build: value })
  return device
}

const retry: Scenario = {
  id: 'retry',
  nav: 'Retries',
  primitives: ['decide.fail()', 'decide.requeue()'],
  title: 'A start hook can fail, or retry later',
  intro: [
    'A start hook returns a decision with `decide`: `fail()` gives up, while `requeue()` tries the hook again after a delay.',
    'While waiting to retry, the unit keeps its instance, and the units that depend on it wait.',
  ],
  question: 'device fails to connect on the first try. What happens?',
  file: 'device.ts',
  section: 'retries',
  nodes: [{ id: 'device', x: 0, y: 0 }, { id: 'monitor', x: 1, y: 0 }, { id: 'app', x: 2, y: 0 }],
  edges: [{ from: 'monitor', to: 'device' }, { from: 'app', to: 'monitor' }],
  variants: [
    {
      id: 'fail',
      primitive: 'decide.fail()',
      tone: 'bad',
      outcome: 'Stays failed',
      summary: 'device fails and stays failed while monitor and app wait. Calling replace() with a fixed build recovers it.',
      key: 0,
      run: async (lab) => {
        const device = retryGraph(lab, decide => decide.fail(new Error('connect failed')))
        lab.start()
        await lab.step('start(): the start hook of device fails. monitor and app wait.', { focus: ['device'], note: 'failed', lines: [6] })
        lab.advance(2_000)
        await lab.step('2 s later: nothing retries.', { focus: ['device'], note: 'still failed' })
        lab.track('replace()', device.replace(value))
        await lab.step('replace() with a fixed build. device starts, followed by monitor and app.', { focus: ['device', 'monitor', 'app'], note: 'fixed' })
      },
    },
    {
      id: 'requeue',
      primitive: 'decide.requeue()',
      tone: 'good',
      outcome: 'Retries',
      summary: 'device waits in retrying with its instance, and build does not run again. The third try succeeds, and monitor and app start.',
      key: 0,
      run: async (lab) => {
        retryGraph(lab, decide => decide.requeue({ after: 1_000, reason: 'connect failed' }))
        lab.start()
        await lab.step('start(): try 1 fails. device waits in retrying with its instance.', { focus: ['device'], note: 'retrying', lines: [6] })
        lab.advance(1_000)
        await lab.step('1 s later: try 2 fails too.', { focus: ['device'], note: 'try 2', lines: [3, 6] })
        lab.advance(1_000)
        await lab.step('2 s later: try 3 succeeds. device is running, and monitor and app start.', { focus: ['device', 'monitor', 'app'], note: 'try 3 works', lines: [3] })
      },
    },
    {
      id: 'max-attempts',
      primitive: 'requeue({ maxAttempts })',
      tone: 'warn',
      outcome: 'Gives up after 2 tries',
      summary: 'With maxAttempts: 2, the second failure ends the retries, and device fails with the last reason.',
      key: 1,
      run: async (lab) => {
        retryGraph(lab, decide => decide.requeue({ after: 1_000, maxAttempts: 2, reason: 'connect failed' }))
        lab.start()
        await lab.step('start(): try 1 fails. device waits in retrying.', { focus: ['device'], note: 'retrying', lines: [6] })
        lab.advance(1_000)
        await lab.step('1 s later: try 2 fails. That was the last attempt, so device enters failed.', { focus: ['device'], note: 'gave up', lines: [6] })
      },
    },
  ],
}

// Transactions --------------------------------------------------------------------------------------------------------

const memoryKey = defineKey<object>('memory')
const agentKey = defineKey<object>('agent')

function pluginGraph(lab: Lab) {
  const llm = provide(lab.host, 'llm', value)
  provide(lab.host, 'app', { dependsOn: { agent: agentKey }, build: value })
  return llm
}

async function gatedMemory(lab: Lab): Promise<object> {
  await lab.gate('memory')
  return {}
}

const plugin: Scenario = {
  id: 'plugin',
  nav: 'Transactions',
  primitives: ['transaction()', 'tx.commit()'],
  title: 'Some units only work together',
  intro: [
    'A unit registered with `provide()` is published right away. But a plugin often brings several units that only work as a set.',
    'A transaction builds its units before publishing them, and publishes all of them in one step only if every build succeeds.',
  ],
  question: 'A plugin adds memory and agent, and the build of agent fails. What do other units see?',
  file: 'plugin.ts',
  section: 'transactions',
  nodes: [{ id: 'llm', x: 0, y: 1 }, { id: 'memory', x: 0, y: 0 }, { id: 'agent', x: 1, y: 0.5 }, { id: 'app', x: 2, y: 0.5 }],
  edges: [{ from: 'agent', to: 'memory' }, { from: 'agent', to: 'llm' }, { from: 'app', to: 'agent' }],
  variants: [
    {
      id: 'provide',
      primitive: 'provide() each',
      tone: 'bad',
      outcome: 'Half the plugin is live',
      summary: 'Each unit is visible right away. memory runs, agent fails, and half of the plugin stays live.',
      key: 2,
      run: async (lab) => {
        const llm = pluginGraph(lab)
        lab.start()
        await lab.step('start(): llm is running. app waits for agent.')
        provide(lab.host, memoryKey, () => gatedMemory(lab))
        provide(lab.host, agentKey, {
          dependsOn: { memory: memoryKey, llm },
          build: () => {
            throw new Error('bad config')
          },
        })
        await lab.step('provide(): memory builds. agent is visible too, and waits for memory.', { focus: ['memory', 'agent'], note: 'visible right away', lines: [1, 2] })
        lab.open('memory')
        await lab.step('memory is running, while agent fails to build. Half of the plugin stays live.', { focus: ['memory', 'agent'], note: 'live alone', lines: [4] })
      },
    },
    {
      id: 'commit',
      primitive: 'tx.commit()',
      tone: 'good',
      outcome: 'All or nothing',
      summary: 'commit() builds memory and agent before publishing, then publishes both in one step, and app starts.',
      key: 1,
      run: async (lab) => {
        const llm = pluginGraph(lab)
        lab.start()
        await lab.step('start(): llm is running. app waits for agent.')
        const tx = transaction(lab.host)
        tx.provide(memoryKey, () => gatedMemory(lab))
        tx.provide(agentKey, { dependsOn: { memory: memoryKey, llm }, build: value })
        lab.track('commit()', tx.commit())
        await lab.step('commit(): memory builds before publishing. app cannot see it yet.', { focus: ['memory', 'agent'], note: 'not published', lines: [4] })
        lab.open('memory')
        await lab.step('agent builds too. Both are published in one step, and app starts.', { focus: ['memory', 'agent', 'app'], note: 'published together' })
      },
    },
    {
      id: 'rollback',
      primitive: 'tx.commit(), a build fails',
      tone: 'good',
      outcome: 'Nothing is published',
      summary: 'agent fails to build. commit() rejects, memory is disposed, and no other unit ever saw either one.',
      key: 2,
      run: async (lab) => {
        const llm = pluginGraph(lab)
        lab.start()
        await lab.step('start(): llm is running. app waits for agent.')
        const tx = transaction(lab.host)
        tx.provide(memoryKey, () => gatedMemory(lab))
        tx.provide(agentKey, {
          dependsOn: { memory: memoryKey, llm },
          build: () => {
            throw new Error('bad config')
          },
        })
        lab.track('commit()', tx.commit())
        await lab.step('commit(): memory builds before publishing. app cannot see it yet.', { focus: ['memory', 'agent'], note: 'not published', lines: [4] })
        lab.open('memory')
        await lab.step('agent fails to build. commit() rejects and disposes memory. Nothing was published.', { focus: ['memory', 'agent'], note: 'rolled back', lines: [4] })
      },
    },
  ],
}

// Child containers ----------------------------------------------------------------------------------------------------

const containers: Scenario = {
  id: 'containers',
  nav: 'Containers',
  primitives: ['createContainer()', 'isolate', 'exclusive'],
  title: 'A plugin gets its own container',
  intro: [
    'A container holds registrations. A child container, such as one for each plugin, looks up its own units first, then those of its parent containers.',
    'The parent sees no unit of the child unless the unit has `visibility: \'parent\'`. Disposing the child cleans up everything it owns.',
  ],
  question: 'The host has a theme, and a plugin provides its own. Which theme does each unit get?',
  file: 'plugin.ts',
  section: 'containers',
  nodes: [{ id: 'theme', x: 0, y: 0 }, { id: 'app', x: 1, y: 0 }, { id: 'plugin/theme', x: 0, y: 1 }, { id: 'plugin/view', x: 1, y: 1 }],
  boxes: [{ label: 'host', nodes: ['theme', 'app'] }, { label: 'plugin', nodes: ['plugin/theme', 'plugin/view'] }],
  edges: [{ from: 'app', to: 'theme' }, { from: 'plugin/view', to: 'theme' }, { from: 'plugin/view', to: 'plugin/theme' }],
  variants: [
    {
      id: 'shadow',
      primitive: 'provide(plugin)',
      tone: 'good',
      outcome: 'view switches, app stays',
      summary: 'view keeps the host theme while the plugin theme builds, then switches to it. When withdrawn, view switches back without stopping. app never sees the plugin theme.',
      key: 1,
      run: async (lab) => {
        const child = lab.plugin('plugin')
        const theme = provide(lab.host, 'theme', value)
        provide(lab.host, 'app', { dependsOn: { theme }, build: value })
        provide(child, 'view', { dependsOn: { theme: 'theme' }, build: value })
        lab.start()
        await lab.step('start(): view uses the theme from the host.', { focus: ['plugin/view'], note: 'uses host theme', lines: [1, 2] })
        const own = provide(child, 'theme', async () => {
          await lab.gate('plugin-theme')
          return {}
        })
        await lab.step('The plugin provides its own theme. While it builds, view keeps the host theme.', { focus: ['plugin/theme', 'plugin/view'], note: 'builds', lines: [4] })
        lab.open('plugin-theme')
        await lab.step('The plugin theme is running, so view switches to it. app stays on the host theme.', { focus: ['plugin/view', 'app'], note: 'switched' })
        lab.track('withdraw()', own.withdraw())
        await lab.step('The plugin theme is withdrawn. view switches back to the host theme without stopping.', { focus: ['plugin/view'], note: 'back to host', lines: [5] })
      },
    },
    {
      id: 'isolate',
      primitive: 'isolate: [key]',
      tone: 'warn',
      outcome: 'Only its own theme',
      summary: 'With isolate, view does not see the host theme. It waits until the plugin theme is running.',
      key: 0,
      edges: [{ from: 'app', to: 'theme' }, { from: 'plugin/view', to: 'plugin/theme' }],
      run: async (lab) => {
        const child = lab.plugin('plugin', { isolate: ['theme'] })
        const theme = provide(lab.host, 'theme', value)
        provide(lab.host, 'app', { dependsOn: { theme }, build: value })
        provide(child, 'view', { dependsOn: { theme: 'theme' }, build: value })
        lab.start()
        await lab.step('start(): the plugin isolates theme. view does not see the host theme, so it waits.', { focus: ['plugin/view'], note: 'waits', lines: [1, 2] })
        provide(child, 'theme', value)
        await lab.step('The plugin provides its own theme, and view builds with it.', { focus: ['plugin/theme', 'plugin/view'], note: 'own theme', lines: [3] })
      },
    },
    {
      id: 'exclusive',
      primitive: 'defineKey(…, { exclusive })',
      tone: 'bad',
      outcome: 'Both stop: conflict',
      summary: 'theme is exclusive. A second provider puts both in conflict: neither runs, and app and view wait until one is withdrawn.',
      key: 1,
      run: async (lab) => {
        const themeKey = defineKey<object>('theme', { exclusive: true })
        const child = lab.plugin('plugin')
        provide(lab.host, themeKey, value)
        provide(lab.host, 'app', { dependsOn: { theme: themeKey }, build: value })
        provide(child, 'view', { dependsOn: { theme: themeKey }, build: value })
        lab.start()
        await lab.step('start(): one provider of the exclusive key theme. Everything runs.', { lines: [1, 2] })
        const second = provide(child, themeKey, value)
        await lab.step('The plugin provides theme too. Both providers enter conflict, and app and view wait.', { focus: ['theme', 'plugin/theme'], note: 'conflict', lines: [3] })
        lab.track('withdraw()', second.withdraw())
        await lab.step('The plugin provider is withdrawn. The host theme runs again, and app and view follow.', { focus: ['theme', 'app', 'plugin/view'], note: 'runs again' })
      },
    },
  ],
}

// Cancellation --------------------------------------------------------------------------------------------------------

const cancel: Scenario = {
  id: 'cancel',
  nav: 'Waiting with a limit',
  primitives: ['timeout()', '{ signal }'],
  title: 'A wait can have a time limit',
  intro: [
    '`start()` and `resolve()` wait while a provider is missing. Pass a `signal` to stop waiting after a limit.',
    '`timeout(container, ms)` creates a signal on the container clock. Only the wait ends: the units keep running.',
  ],
  file: 'main.ts',
  section: 'cancellation',
  nodes: [{ id: 'llm', x: 0, y: 0 }, { id: 'app', x: 1, y: 0 }],
  edges: [{ from: 'app', to: 'llm' }],
  variants: [{
    id: 'main',
    primitive: 'timeout()',
    tone: 'good',
    outcome: 'The wait ends',
    summary: 'start() rejects after 5 s, but app keeps waiting, and builds when llm is provided.',
    key: 1,
    run: async (lab) => {
      provide(lab.host, 'app', { dependsOn: { llm: 'llm' }, build: value })
      lab.track('start()', start(lab.host, { signal: timeout(lab.host, 5_000) }))
      await lab.step('start(): app waits for llm, which has no provider yet.', { focus: ['app'], note: 'waits', lines: [1, 3] })
      lab.advance(5_000)
      await lab.step('5 s later: start() rejects with StartTimeoutError. app still waits.', { focus: ['app'], note: 'still waits', lines: [4] })
      provide(lab.host, 'llm', value)
      await lab.step('llm is provided later. app builds as usual.', { focus: ['llm', 'app'], note: 'builds' })
    },
  }],
}

export const SCENARIOS: readonly Scenario[] = [unit, dependency, lifecycle, swap, status, late, retry, plugin, containers, cancel]

/** Runs one variant in a new lab and returns its frames. */
export async function runVariant(scenario: Scenario, variant: Variant, createLab: (edges: readonly LabEdge[]) => Lab) {
  const lab = createLab(edgesOf(scenario, variant))
  await variant.run(lab)
  return lab.frames
}
