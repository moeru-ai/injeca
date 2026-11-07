// The lab runs the real injeca, on a manual clock, and records a frame after each step of a scenario.
// A frame is what the page draws: the instances of each node, the state of each edge, and the observe records of the step.
// So the page never tells a story that injeca does not do. The tests in lab.test.ts keep the frames in snapshots.

import type { Container, ContainerOptions, ObserveRecord, OwnerRecord, UnitPhase, UnitStatus } from 'injeca'

import { createContainer, createNoopLogger, graph, observe, start } from 'injeca'
import { drained, manualClock } from 'injeca/testing'

/** One instance of a node, or a unit without an instance. `version` counts the instances of the node: 1, 2, and so on. */
export interface InstanceView {
  readonly version?: number
  readonly phase: UnitPhase
  readonly status?: UnitStatus
}

/**
 * The state of a drawn edge from a consumer to a provider.
 *
 * - `serving`: the edge selects this provider, and it serves.
 * - `waiting`: the edge selects this provider, but it does not serve yet.
 * - `idle`: the edge does not select this provider now.
 */
export type EdgeState = 'serving' | 'waiting' | 'idle'

export interface LogLine {
  readonly node: string
  readonly text: string
  readonly tone: 'new' | 'activity' | 'good' | 'bad' | 'quiet'
}

/** What a step points at: the nodes to watch, a short note beside the first one, and the lines of code that run. */
export interface StepMeta {
  readonly focus?: readonly string[]
  readonly note?: string
  readonly lines?: readonly number[]
}

/** The state of a call that a scenario makes and the page shows, for example `start()` that waits. */
export interface CallView {
  readonly label: string
  readonly state: 'waiting' | 'resolved' | 'rejected'
  readonly detail?: string
}

export interface Frame extends StepMeta {
  readonly caption: string
  /** The time of the manual clock, in milliseconds. */
  readonly time: number
  readonly nodes: Readonly<Record<string, readonly InstanceView[]>>
  /** By edge id: `<from>-><to>`. */
  readonly edges: Readonly<Record<string, EdgeState>>
  readonly log: readonly LogLine[]
  readonly calls: readonly CallView[]
}

export interface LabEdge {
  readonly from: string
  readonly to: string
  readonly optional?: boolean
}

export const edgeId = (edge: LabEdge): string => `${edge.from}->${edge.to}`

/** The node id of a unit: its key in the host container, or `<owner id>/<key>` in another container. */
export function nodeIdOf(owner: OwnerRecord, key: string): string {
  return typeof owner.id === 'string' ? `${owner.id}/${key}` : key
}

function splitNodeId(id: string): { readonly owner?: string, readonly key: string } {
  const at = id.indexOf('/')
  return at < 0 ? { key: id } : { owner: id.slice(0, at), key: id.slice(at + 1) }
}

const PHASE_TONE: Partial<Record<UnitPhase, LogLine['tone']>> = {
  building: 'activity',
  conflict: 'bad',
  declared: 'new',
  failed: 'bad',
  retrying: 'activity',
  running: 'good',
  starting: 'activity',
  stopping: 'activity',
}

export interface Lab {
  /** The host container. Its owner is `{ kind: 'host' }`. */
  readonly host: Container
  /** Creates a child container of the host, with the owner `{ kind: 'plugin', id }`. */
  readonly plugin: (id: string, options?: Omit<ContainerOptions, 'parent' | 'owner' | 'clock'>) => Container
  /** Starts the host and its children without waiting, so a unit that waits for a provider cannot block the scenario. */
  readonly start: () => void
  /** A promise that a build or a hook awaits, until `open(name)`. */
  readonly gate: (name: string) => Promise<void>
  readonly open: (name: string) => void
  /** Moves the manual clock. */
  readonly advance: (ms: number) => void
  /** Waits until the work queue stays drained, then records a frame. */
  readonly step: (caption: string, meta?: StepMeta) => Promise<void>
  /** Shows the state of a call in the next frames, until it changes. */
  readonly call: (label: string, state: CallView['state'], detail?: string) => void
  /** Tracks a promise as a call: `waiting` now, then `resolved` or `rejected` with the name of the error. */
  readonly track: (label: string, promise: Promise<unknown>) => void
  readonly frames: Frame[]
  /** Reads the state now, without a wait. It takes the observe records since the last read. The sandbox draws it. */
  readonly snapshot: (caption?: string) => Frame
  /** Calls `listener` after each observe record. Returns a function that removes it. */
  readonly onChange: (listener: () => void) => () => void
  /** Changes the drawn edges, for a graph that the sandbox edits. */
  readonly setEdges: (edges: readonly LabEdge[]) => void
}

export interface LabOptions {
  /**
   * `manual`, the default, drives the injeca clock by `advance()`, so a scenario controls time.
   * `system` uses real time, for the sandbox.
   */
  readonly clock?: 'manual' | 'system'
}

/**
 * Creates a lab for one run of one variant.
 *
 * @param initialEdges The drawn edges of the scenario. The lab reads the state of each one from `graph().dependencies()`.
 */
export function createLab(initialEdges: readonly LabEdge[], options: LabOptions = {}): Lab {
  let edges = initialEdges
  const { clock, advance } = manualClock()
  const host = createContainer({ ...(options.clock === 'system' ? {} : { clock }), logger: createNoopLogger(), owner: { kind: 'host' } })
  const listeners = new Set<() => void>()
  const containers = new Map<string | undefined, Container>([[undefined, host]])
  const frames: Frame[] = []
  const calls = new Map<string, CallView>()
  let now = 0

  // Each instance id gets a small version number, per node, in the order that the lab sees it.
  const versions = new Map<string, number>()
  const counts = new Map<string, number>()
  function versionOf(node: string, instanceId: string | undefined): number | undefined {
    if (instanceId === undefined)
      return undefined
    let version = versions.get(instanceId)
    if (version === undefined) {
      version = (counts.get(node) ?? 0) + 1
      counts.set(node, version)
      versions.set(instanceId, version)
    }

    return version
  }

  // The first frame shows each instance as v1, also when injeca built another instance before it.
  // For example, a unit with an optional dependency builds once without it, and again when it runs.
  let bases: Map<string, number> | undefined
  const shown = (node: string, version: number | undefined): number | undefined =>
    version === undefined ? undefined : version - (bases?.get(node) ?? 0)

  // Records wait until the step, so that their versions use the bases of the first frame.
  let pending: { readonly node: string, readonly version: number | undefined, readonly body: string, readonly tone: LogLine['tone'] }[] = []
  observe(host, (record: ObserveRecord) => {
    const node = nodeIdOf(record.owner, record.key)
    const version = versionOf(node, record.instanceId)
    const push = (body: string, tone: LogLine['tone']) => pending.push({ node, version, body, tone })
    switch (record.type) {
      case 'phase':
        // A replayed record has no `from`. The first frame shows that state.
        if (record.from !== undefined)
          push(`${record.from} → ${record.to}${record.decision ? ` (${record.decision})` : ''}`, PHASE_TONE[record.to] ?? 'quiet')
        break
      case 'status':
        if (record.from !== undefined)
          push(`${record.from} → ${record.to}`, record.to === 'ready' ? 'good' : record.to === 'degraded' ? 'activity' : 'bad')
        break
      case 'ignored':
        push(`${record.call}() was ignored${record.reason ? `: ${record.reason}` : ''}`, 'bad')
        break
      case 'decision':
        push(`${record.hook} returned ${record.decision}${record.decision === 'requeue' ? `, attempt ${record.attempt}` : ''}`, record.decision === 'fail' ? 'bad' : 'quiet')
    }
    // Every record can change what the sandbox draws, so each one tells the listeners.
    for (const listener of listeners)
      listener()
  })

  const gates = new Map<string, { promise: Promise<void>, open: () => void }>()
  function gateOf(name: string): { promise: Promise<void>, open: () => void } {
    let gate = gates.get(name)
    if (!gate) {
      let open!: () => void
      const promise = new Promise<void>((resolve) => {
        open = resolve
      })
      gate = { promise, open }
      gates.set(name, gate)
    }

    return gate
  }

  /** Tells whether `edge` is the drawn edge of its consumer to `key` that a missing provider would fill: in the container of the consumer, or else in the host. */
  function waitsFor(edge: LabEdge, key: string): boolean {
    const from = splitNodeId(edge.from)
    const drawn = edges.filter(other => other.from === edge.from && splitNodeId(other.to).key === key)
    const own = drawn.find(other => splitNodeId(other.to).owner === from.owner)
    return (own ?? drawn.find(other => splitNodeId(other.to).owner === undefined)) === edge
  }

  function edgeState(edge: LabEdge): EdgeState {
    const from = splitNodeId(edge.from)
    const to = splitNodeId(edge.to)
    const container = containers.get(from.owner)
    if (!container)
      return 'idle'
    let dependencies
    try {
      if (!graph(container).units().some(unit => nodeIdOf(unit.owner, unit.key) === edge.from))
        return 'idle'
      dependencies = graph(container).dependencies(from.key)
    }
    catch {
      return 'idle'
    }
    for (const dependency of dependencies) {
      if (!dependency.keys.includes(to.key))
        continue
      const provider = dependency.provider
      if (!provider) {
        // A required key without a provider: the consumer waits for the drawn provider, the one in its own container first.
        return !dependency.optional && dependency.keys[0] === to.key && waitsFor(edge, to.key) ? 'waiting' : 'idle'
      }
      if (provider.key !== to.key || nodeIdOf(provider.owner, provider.key) !== edge.to)
        continue

      return dependency.resolution === 'resolved' ? 'serving' : 'waiting'
    }

    return 'idle'
  }

  return {
    host,
    plugin: (id, options) => {
      const container = createContainer({ ...options, parent: host, owner: { kind: 'plugin', id } })
      containers.set(id, container)
      return container
    },
    start: () => {
      for (const container of containers.values())
        start(container).catch(() => {})
    },
    gate: name => gateOf(name).promise,
    open: name => gateOf(name).open(),
    advance: (ms) => {
      now += ms
      advance(ms)
    },
    step: async (caption, meta) => {
      await drained(host)
      frames.push({ ...snapshot(caption), ...meta })
    },
    call: (label, state, detail) => {
      calls.set(label, { label, state, ...(detail === undefined ? {} : { detail }) })
    },
    track: (label, promise) => {
      calls.set(label, { label, state: 'waiting' })
      promise.then(
        value => calls.set(label, { label, state: 'resolved', ...(value === undefined ? {} : { detail: String(value) }) }),
        (error: unknown) => calls.set(label, { label, state: 'rejected', detail: error instanceof Error ? error.name : String(error) }),
      )
    },
    frames,
    snapshot: caption => snapshot(caption),
    setEdges: (next) => {
      edges = next
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  function snapshot(caption = ''): Frame {
    const units = graph(host).units().map(unit => ({ unit, node: nodeIdOf(unit.owner, unit.key) }))
    if (!bases) {
      bases = new Map()
      for (const { unit, node } of units) {
        const version = versionOf(node, unit.instanceId)
        if (version !== undefined)
          bases.set(node, Math.min(bases.get(node) ?? Infinity, version - 1))
      }
    }

    const nodes: Record<string, InstanceView[]> = {}
    for (const { unit, node } of units) {
      const version = shown(node, versionOf(node, unit.instanceId))
        ;(nodes[node] ??= []).push({
        phase: unit.phase,
        ...(version === undefined ? {} : { version }),
        ...(unit.status === undefined ? {} : { status: unit.status }),
      })
    }
    for (const views of Object.values(nodes))
      views.sort((a, b) => (a.version ?? Infinity) - (b.version ?? Infinity))

    const log = pending.map(({ node, version, body, tone }) => {
      const v = shown(node, version)
      // An instance from before the first frame has no version to show.
      return { node, text: `${v === undefined || v < 1 ? node : `${node} v${v}`}: ${body}`, tone }
    })
    pending = []
    return {
      caption,
      time: now,
      nodes,
      edges: Object.fromEntries(edges.map(edge => [edgeId(edge), edgeState(edge)])),
      log,
      calls: [...calls.values()],
    }
  }
}
