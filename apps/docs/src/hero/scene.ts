// The units of the hero, and the story it tells: how injeca works.
//
// 1. Registered: modules call provide(), and the registry holds every unit. Nothing builds yet.
// 2. Requested: resolve() asks for four units. Its call is the entry point of the graph, and app is what it returns.
// 3. Traversed: injeca walks back from the entry point to find what each unit needs. The rest stays pending.
// 4. Built: each batch builds in parallel as soon as its dependencies are running.
// 5. app: the pieces lock together, and resolve() returns app.
// 6. Stopped: stop() stops dependents first, then their providers.

import { chromaticColorFrom } from '@proj-airi/chromatic'

/** A cell of a piece, in units of one cube. For a piece that app needs, a cell of the 3 × 3 × 3 cube, from 0 to 2. */
export type Cell = readonly [number, number, number]

export interface HeroUnit {
  readonly id: string
  readonly role: string
  /** The keys it depends on. */
  readonly needs: readonly string[]
  /**
   * The cells of its piece. The pieces that app needs fill the 3 × 3 × 3 cube exactly, so together they are one
   * solid: app. The other pieces fit nowhere in it.
   */
  readonly cells: readonly Cell[]
  /** Not needed by the entry: registered, and left pending. */
  readonly unused?: boolean
}

// The cube is cut in three layers, from the back (z = 0) to the front (z = 2):
//
//   z = 0          z = 1          z = 2
//   y=2  a a b     d e e          g h h
//   y=1  c a b     d d e          g h h
//   y=0  c c b     f f f          g g g
//        x=0 1 2   x=0 1 2        x=0 1 2
//
// The first batch (config, tts, llm, memory) is the back and the floor of the middle. The second batch fills the
// rest, so the cube grows from the back to the front.
const at = (z: number, cells: readonly (readonly [number, number])[]): Cell[] => cells.map(([x, y]) => [x, y, z])

export const UNITS: readonly HeroUnit[] = [
  { id: 'config', role: 'Loads configuration from disk.', needs: [], cells: at(0, [[0, 2], [1, 2], [1, 1]]) },
  { id: 'tts', role: 'Synthesizes speech from text.', needs: [], cells: at(0, [[2, 0], [2, 1], [2, 2]]) },
  { id: 'llm', role: 'Language model client.', needs: [], cells: at(0, [[0, 0], [1, 0], [0, 1]]) },
  { id: 'memory', role: 'Persists conversation history.', needs: [], cells: at(1, [[0, 0], [1, 0], [2, 0]]) },
  { id: 'window', role: 'Main application window.', needs: ['config'], cells: at(1, [[0, 2], [0, 1], [1, 1]]) },
  { id: 'tray', role: 'System tray icon and menu.', needs: ['config'], cells: at(1, [[1, 2], [2, 2], [2, 1]]) },
  { id: 'speech', role: 'Speaks assistant replies aloud.', needs: ['tts'], cells: at(2, [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]]) },
  { id: 'chat', role: 'Manages model turns and conversation threads.', needs: ['llm', 'memory'], cells: at(2, [[1, 1], [2, 1], [1, 2], [2, 2]]) },
  { id: 'telemetry', role: 'Reports usage metrics. Not needed by app.', needs: ['config'], unused: true, cells: at(0, [[0, 0], [1, 0], [2, 0], [1, 1]]) },
  { id: 'devtools', role: 'Inspector panel. Not needed by app.', needs: [], unused: true, cells: at(0, [[0, 0], [1, 0]]) },
  { id: 'vision', role: 'Captures screen context. Not needed by app.', needs: ['llm'], unused: true, cells: at(0, [[0, 0], [1, 0], [1, 1], [2, 1]]) },
  { id: 'updater', role: 'Checks for application updates. Not needed by app.', needs: ['config'], unused: true, cells: at(0, [[0, 0]]) },
]

/** The entry of the graph: the call of resolve(). It is not a unit. What it returns, all four together, is app. */
export const ENTRY = { id: 'app', needs: ['window', 'tray', 'speech', 'chat'] } as const

export const byId = (id: string): HeroUnit => UNITS.find(unit => unit.id === id)!
export function usedBy(id: string): string[] {
  return [
    ...UNITS.filter(unit => unit.needs.includes(id)).map(unit => unit.id),
    ...(ENTRY.needs.includes(id as never) ? [ENTRY.id] : []),
  ]
}

/** The order of the provide() calls, across many modules. It is the order of the registry. */
export const REGISTERED: readonly string[] = ['config', 'telemetry', 'llm', 'chat', 'devtools', 'tts', 'speech', 'window', 'vision', 'memory', 'tray', 'updater']

/** What the entry needs, level by level from the entry: [window, tray, speech, chat], then [config, tts, llm, memory]. */
export const LEVELS: readonly (readonly string[])[] = (() => {
  const levels: string[][] = [[...ENTRY.needs]]
  const seen = new Set<string>(ENTRY.needs)
  while (true) {
    const next = [...new Set(levels.at(-1)!.flatMap(id => byId(id).needs))].filter(id => !seen.has(id))
    if (next.length === 0)
      return levels
    next.forEach(id => seen.add(id))
    levels.push(next)
  }
})()

/** The build order: the leaves first. Each batch builds at once, after the batches that it needs. */
export const BATCHES: readonly (readonly string[])[] = [...LEVELS].reverse()

/** The batch of each unit that app needs, from 1. */
export const BATCH_OF: ReadonlyMap<string, number> = new Map(BATCHES.flatMap((batch, i) => batch.map(id => [id, i + 1] as const)))

/**
 * The color of each piece that app needs: neighbors on one band of the wheel, from teal to violet, at a soft
 * saturation. A lighter and a darker shade take turns, so the pieces part from each other and the cube still reads
 * as one thing. The pieces that app does not need have no color.
 */
const PIECES: Readonly<Record<string, { readonly hue: number, readonly deep: boolean }>> = {
  config: { hue: 230, deep: false },
  tts: { hue: 185, deep: true },
  llm: { hue: 260, deep: false },
  memory: { hue: 305, deep: true },
  window: { hue: 200, deep: false },
  tray: { hue: 275, deep: true },
  speech: { hue: 215, deep: true },
  chat: { hue: 290, deep: false },
}

export function colorOf(id: string): string | undefined {
  const piece = PIECES[id]
  return piece && chromaticColorFrom(piece.hue, { shade: piece.deep ? 400 : 300, saturation: 70 }).toHex()
}

export const NEEDED = BATCH_OF.size

export const STEPS = [
  { title: 'Registered', code: 'provide()', text: `Modules register ${UNITS.length} units. Nothing builds yet.` },
  { title: 'Requested', code: 'resolve(container, { window, tray, speech, chat })', text: 'This call is the entry point of the dependency graph.' },
  { title: 'Traversed', code: '', text: `Walking back from the entry point: it needs ${NEEDED} of the ${UNITS.length} units across ${BATCHES.length} batches. The rest stay pending.` },
  { title: 'Built', code: '', text: 'Each batch builds in parallel as soon as its dependencies are running.' },
  { title: 'app', code: '', text: 'The pieces lock together into app, and resolve() returns.' },
  { title: 'Stopped', code: 'stop()', text: 'Dependents stop first, followed by their providers.' },
] as const

/** The start of each moment of the loop, in milliseconds. */
export const TIMES = { registered: 0, asked: 2200, solved: 4400, built: 7200, app: 10600, stopped: 13400, end: 16600 } as const
