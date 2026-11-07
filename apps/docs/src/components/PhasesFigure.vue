<script setup lang="ts">
import type { UnitPhase } from 'injeca'

import Token from '../stage/Token.vue'

/**
 * The README figure of the phases of a unit: each phase with the token that the lab draws for it and what it means,
 * and each move with what makes it. The main path runs left to right. Retries, failures, conflicts, and the end of a
 * unit branch off it. A running unit also has a status.
 */
interface Phase { readonly phase: UnitPhase, readonly x: number, readonly y: number, readonly text: string }

const W = 158
const H = 70

const PHASES: readonly Phase[] = [
  { phase: 'declared', x: 36, y: 196, text: 'reserved by a transaction' },
  { phase: 'pending', x: 296, y: 196, text: 'waits for what it needs' },
  { phase: 'building', x: 556, y: 196, text: 'build runs' },
  { phase: 'starting', x: 816, y: 196, text: 'start hooks run' },
  { phase: 'running', x: 1076, y: 196, text: 'serves calls' },
  { phase: 'conflict', x: 686, y: 40, text: 'two providers of an exclusive key' },
  { phase: 'retrying', x: 816, y: 360, text: 'waits for the next try' },
  { phase: 'failed', x: 556, y: 360, text: 'a build or a hook failed' },
  { phase: 'stopping', x: 1076, y: 360, text: 'waits for its dependents' },
  { phase: 'withdrawn', x: 1266, y: 360, text: 'after withdraw(): disposed' },
]

const at = (phase: UnitPhase) => PHASES.find(p => p.phase === phase)!
const right = (p: Phase) => ({ x: p.x + W, y: p.y + H / 2 })
const left = (p: Phase) => ({ x: p.x, y: p.y + H / 2 })
const top = (p: Phase, dx = 0) => ({ x: p.x + W / 2 + dx, y: p.y })
const bottom = (p: Phase, dx = 0) => ({ x: p.x + W / 2 + dx, y: p.y + H })

interface Move { readonly d: string, readonly label: string, readonly lx: number, readonly ly: number, readonly anchor?: 'start' | 'middle' | 'end' }

function line(a: { x: number, y: number }, b: { x: number, y: number }): string {
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`
}

type Point = { x: number, y: number }

const MOVES: readonly Move[] = (() => {
  const [declared, pending, building, starting, running, conflict, retrying, failed, stopping, withdrawn]
    = (['declared', 'pending', 'building', 'starting', 'running', 'conflict', 'retrying', 'failed', 'stopping', 'withdrawn'] as const).map(at)
  // A straight move, with its label above its middle, or beside it for a vertical move: on the right, or on the left.
  const along = (a: Point, b: Point, label: string, side: 'left' | 'right' = 'right'): Move => a.y === b.y
    ? { d: line(a, b), label, lx: (a.x + b.x) / 2, ly: a.y - 10, anchor: 'middle' }
    : { d: line(a, b), label, lx: side === 'right' ? a.x + 10 : a.x - 10, ly: (a.y + b.y) / 2 + 4, anchor: side === 'right' ? 'start' : 'end' }
  // A curve that turns once, with its label where you give it.
  const bend = (a: Point, corner: Point, b: Point, label: string, lx: number, ly: number, anchor: Move['anchor']): Move =>
    ({ d: `M ${a.x} ${a.y} Q ${corner.x} ${corner.y} ${b.x} ${b.y}`, label, lx, ly, anchor })
  const toConflict = { from: top(running!, 30), to: right(conflict!) }
  const fromConflict = { from: left(conflict!), to: top(pending!, 30) }
  return [
    along(right(declared!), left(pending!), 'commit()'),
    along(right(pending!), left(building!), 'needs run'),
    along(right(building!), left(starting!), 'build returns'),
    along(right(starting!), left(running!), 'hooks done'),
    bend(toConflict.from, { x: toConflict.from.x, y: toConflict.to.y }, toConflict.to, 'a second provider', 1100, 66, 'start'),
    bend(fromConflict.from, { x: fromConflict.to.x, y: fromConflict.from.y }, fromConflict.to, 'one provider left', 560, 66, 'end'),
    along(bottom(starting!, -26), top(retrying!, -26), 'requeue', 'left'),
    along(top(retrying!, 26), bottom(starting!, 26), 'next try'),
    along(bottom(building!), top(failed!), 'throws'),
    along(left(retrying!), right(failed!), 'no tries left'),
    along(bottom(running!), top(stopping!), 'stop(), withdraw()', 'left'),
    along(right(stopping!), left(withdrawn!), ''),
  ]
})()

/** The phases in which a unit has an instance, so its token shows a version. */
const HAS_INSTANCE = new Set<UnitPhase>(['building', 'starting', 'retrying', 'running', 'stopping'])

const STATUSES = [
  { word: 'ready', kind: 'ready' },
  { word: 'degraded', kind: 'degraded' },
  { word: 'unavailable', kind: 'unavailable' },
] as const
</script>

<template>
  <div class="phases" role="img" aria-label="The phases of a unit. declared, then pending until what it needs runs, then building while build runs, then starting while the start hooks run, then running. A start hook can requeue: retrying, then starting again. A build that throws, or the end of the tries, leads to failed. A second provider of an exclusive key leads to conflict, and pending again when one provider is left. stop() and withdraw() lead to stopping, and withdraw() to withdrawn. A running unit has a status: ready, degraded, or unavailable.">
    <svg class="moves" viewBox="0 0 1440 480" aria-hidden="true">
      <defs>
        <marker id="phase-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 1 1 L 8 5 L 1 9" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </marker>
      </defs>
      <g v-for="(move, i) in MOVES" :key="i">
        <path :d="move.d" class="move" marker-end="url(#phase-head)" />
        <text :x="move.lx" :y="move.ly" class="label mono" :text-anchor="move.anchor">{{ move.label }}</text>
      </g>
    </svg>

    <div v-for="p in PHASES" :key="p.phase" class="phase" :class="p.phase" :style="{ left: `${p.x}px`, top: `${p.y}px`, width: `${W}px`, height: `${H}px` }">
      <span class="token">
        <Token :view="HAS_INSTANCE.has(p.phase) ? { phase: p.phase, version: 1 } : { phase: p.phase }" :animated="false" />
      </span>
      <span class="words">
        <span class="name mono">{{ p.phase }}</span>
        <span class="text">{{ p.text }}</span>
      </span>
    </div>

    <!-- A running unit also has a status. setStatus() moves it, and the status goes to what depends on it. -->
    <div class="statuses">
      <span class="caption mono">setStatus()</span>
      <span v-for="s in STATUSES" :key="s.word" class="status">
        <Token :view="{ phase: 'running', status: s.kind, version: 1 }" :animated="false" />
        <span class="mono">{{ s.word }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.phases {
  position: relative;
  overflow: hidden;
  width: 1440px;
  height: 480px;
  border-radius: 32px;
  background: var(--paper);
}

.moves {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.move {
  fill: none;
  stroke: var(--line-strong);
  stroke-width: 1.6;
}

.label {
  fill: var(--muted);
  font-size: 12.5px;
}

.phase {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border-radius: 18px;
  background: var(--control);
}

.phase.running {
  background: var(--surface);
  box-shadow: 0 0 0 2px var(--line-strong);
}

.token {
  flex: none;
}

.words {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.name {
  color: var(--ink);
  font-size: 14px;
}

.text {
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.3;
}

.statuses {
  position: absolute;
  top: 40px;
  left: 1250px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--surface);
}

.caption {
  color: var(--muted);
  font-size: 12px;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-2);
  font-size: 13px;
}

.status :deep(svg),
.token :deep(svg) {
  display: block;
}
</style>
