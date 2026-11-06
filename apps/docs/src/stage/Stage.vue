<script setup lang="ts">
import type { Frame, LabEdge } from '../lab/lab'
import type { ScenarioBox, ScenarioNode } from '../lab/scenarios'
import type { TokenKind } from './look'

import { animate } from 'animejs'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import Token from './Token.vue'
import Wire from './Wire.vue'

import { edgeId } from '../lab/lab'
import { kindOf, pulseOf, wordOf } from './look'

/** What a preview of a change does to a node: from `graph().impact()`. */
export type Highlight = 'stopped' | 'rebuilt' | 'notified'

/**
 * A graph of units drawn as an ink diagram. Each unit is a slot. Each instance is a token in its slot.
 * A new token grows in, an old one shrinks out, and a change of status sends a pulse down the graph, one level at a time.
 * It draws at a design size and scales to fit `width` and `height`, or the width of its parent.
 */
const { t } = useI18n()

const props = withDefaults(defineProps<{
  nodes: readonly ScenarioNode[]
  boxes?: readonly ScenarioBox[]
  edges: readonly LabEdge[]
  frame: Frame | undefined
  width?: number
  height?: number
  /** Providers on top and consumers below. A fluid stage also turns vertical when its space is narrow. */
  vertical?: boolean
  animated?: boolean
  /** Slots react to the pointer and emit `select`. */
  interactive?: boolean
  selected?: string
  highlight?: Readonly<Record<string, Highlight>>
  /** The nodes to watch in this step. The others fade, so the eye goes where the change is. */
  focus?: readonly string[]
  /** A short note beside the first node of `focus`. */
  note?: string
}>(), { animated: true })

const emit = defineEmits<{ select: [node: string] }>()

const NODE_W = 220
const NODE_H = 78

// Without `width`, the wrapper takes the full width of its parent, and the stage fits it.
const measured = ref<number>()
const root = ref<HTMLElement>()
let observer: ResizeObserver | undefined
onMounted(() => {
  const element = root.value
  if (props.width !== undefined || !element)
    return
  observer = new ResizeObserver(() => {
    measured.value = element.clientWidth
  })
  observer.observe(element)
  measured.value = element.clientWidth
})
onBeforeUnmount(() => observer?.disconnect())

const vertical = computed(() => props.vertical || (props.width === undefined && measured.value !== undefined && measured.value < 520))
const boxed = computed(() => (props.boxes?.length ?? 0) > 0)
const PAD_X = computed(() => boxed.value ? 26 : 12)
const PAD_Y = computed(() => boxed.value ? 46 : 12)

// The scenario grid has dependency levels on x and lanes on y. Vertical mode turns levels into rows.
const levels = computed(() => Math.max(...props.nodes.map(node => node.x)) + 1)
const lanes = computed(() => Math.max(...props.nodes.map(node => node.y)) + 1)
const LEVEL_STEP = computed(() => vertical.value ? NODE_H + 54 : NODE_W + 76)
const LANE_STEP = computed(() => vertical.value ? NODE_W + (boxed.value ? 76 : 28) : NODE_H + (boxed.value ? 78 : 34))
const designW = computed(() => PAD_X.value * 2 + (vertical.value ? (lanes.value - 1) * LANE_STEP.value : (levels.value - 1) * LEVEL_STEP.value) + NODE_W)
const designH = computed(() => PAD_Y.value * 2 + (vertical.value ? (levels.value - 1) * LEVEL_STEP.value : (lanes.value - 1) * LANE_STEP.value) + NODE_H)

const scale = computed(() => {
  const width = props.width ?? measured.value ?? designW.value
  const byHeight = props.height === undefined ? Infinity : props.height / designH.value
  // A stage never draws larger than its design size.
  return Math.min(1, width / designW.value, byHeight)
})

function position(id: string): { left: number, top: number } {
  const node = props.nodes.find(n => n.id === id)!
  const level = node.x * LEVEL_STEP.value
  const lane = node.y * LANE_STEP.value
  return vertical.value ? { left: PAD_X.value + lane, top: PAD_Y.value + level } : { left: PAD_X.value + level, top: PAD_Y.value + lane }
}

/** How many levels of providers are above each node. A pulse waits one beat for each level. */
const depth = computed(() => {
  const memo = new Map<string, number>()
  const of = (id: string, seen: Set<string>): number => {
    if (memo.has(id))
      return memo.get(id)!
    if (seen.has(id))
      return 0
    seen.add(id)
    const providers = props.edges.filter(edge => edge.from === id).map(edge => edge.to)
    const value = providers.length === 0 ? 0 : 1 + Math.max(...providers.map(p => of(p, seen)))
    memo.set(id, value)
    return value
  }
  return new Map(props.nodes.map(node => [node.id, of(node.id, new Set())]))
})

type Mood = 'absent' | 'waiting' | 'bad' | 'live'

const slots = computed(() => props.nodes.map((node) => {
  const views = props.frame?.nodes[node.id] ?? []
  let mood: Mood = 'live'
  if (views.length === 0)
    mood = 'absent'
  else if (views.some(view => view.phase === 'failed' || view.phase === 'conflict'))
    mood = 'bad'
  else if (views.every(view => view.phase === 'pending' || view.phase === 'declared'))
    mood = 'waiting'
  const words = [...new Set(views.map(wordOf))]
  return {
    id: node.id,
    key: node.id.slice(node.id.indexOf('/') + 1),
    ...position(node.id),
    views,
    mood,
    // The phases are values of injeca, and stay as they are. A key with no provider has none.
    word: views.length === 0 ? t('chapter.no-provider') : words.join(' · '),
  }
}))

const boxRects = computed(() => (props.boxes ?? []).map((box) => {
  const places = box.nodes.map(position)
  const left = Math.min(...places.map(p => p.left)) - 18
  const top = Math.min(...places.map(p => p.top)) - 18
  const right = Math.max(...places.map(p => p.left)) + NODE_W + 18
  const bottom = Math.max(...places.map(p => p.top)) + NODE_H + 18
  return { label: box.label, left, top, width: right - left, height: bottom - top }
}))

/**
 * Where the wires of a node meet it. Wires that share a side spread out, in the order of the nodes at their other ends,
 * so two wires never end at one point.
 */
const ports = computed(() => {
  const offsets = new Map<string, { out: number, in: number }>()
  const spread = (list: LabEdge[], at: (edge: LabEdge) => string, set: (edge: LabEdge, offset: number) => void) => {
    const groups = new Map<string, LabEdge[]>()
    for (const edge of list)
      groups.set(at(edge), [...(groups.get(at(edge)) ?? []), edge])
    for (const group of groups.values()) {
      group.forEach((edge, i) => set(edge, (i - (group.length - 1) / 2) * 16))
    }
  }
  const lane = (id: string) => props.nodes.find(n => n.id === id)!.y
  const sorted = (key: (edge: LabEdge) => string) => [...props.edges].sort((a, b) => lane(key(a)) - lane(key(b)))
  for (const edge of props.edges)
    offsets.set(edgeId(edge), { out: 0, in: 0 })
  spread(sorted(edge => edge.from), edge => edge.from, (edge, offset) => {
    offsets.get(edgeId(edge))!.in = offset
  })
  spread(sorted(edge => edge.to), edge => edge.to, (edge, offset) => {
    offsets.get(edgeId(edge))!.out = offset
  })
  return offsets
})

const wires = computed(() => props.edges.map((edge) => {
  // A wire goes from the provider to the consumer.
  const from = position(edge.to)
  const to = position(edge.from)
  const port = ports.value.get(edgeId(edge))!
  let x1, y1, x2, y2, d
  if (vertical.value) {
    x1 = from.left + NODE_W / 2 + port.out
    y1 = from.top + NODE_H
    x2 = to.left + NODE_W / 2 + port.in
    y2 = to.top
    const bend = Math.max(22, (y2 - y1) / 2)
    d = `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`
  }
  else {
    x1 = from.left + NODE_W
    y1 = from.top + NODE_H / 2 + port.out
    x2 = to.left
    y2 = to.top + NODE_H / 2 + port.in
    const bend = Math.max(30, (x2 - x1) / 2)
    d = `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`
  }
  return {
    id: edgeId(edge),
    d,
    end: { x: x2, y: y2 },
    // The middle of the curve. The curve is symmetric, so it is the middle of the line between its ends.
    label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2, anchor: 'middle' as const },
    optional: edge.optional === true,
    state: props.frame?.edges[edgeId(edge)] ?? 'idle' as const,
  }
}))

const focused = computed(() => new Set(props.focus ?? []))
const dimmed = (id: string) => focused.value.size > 0 && !focused.value.has(id)

/**
 * A thin ring around each node in focus. The rings keep their order from step to step, so a ring slides from the
 * node that changed before to the node that changes now, and the eye follows it. The first ring is the main one.
 */
const RING_PAD = 9
const rings = computed(() => (props.focus ?? [])
  .filter(id => props.nodes.some(node => node.id === id))
  .map((id) => {
    const place = position(id)
    return { left: place.left - RING_PAD, top: place.top - RING_PAD, width: NODE_W + RING_PAD * 2, height: NODE_H + RING_PAD * 2 }
  }))

/** The note sits above the first node in focus, and moves in at each step. */
const notePlace = computed(() => {
  const first = props.focus?.find(id => props.nodes.some(node => node.id === id))
  return first && props.note ? position(first) : undefined
})
const noteElement = ref<HTMLElement>()
watch(() => [props.note, props.focus?.[0], props.frame], async () => {
  await nextTick()
  if (props.animated && noteElement.value)
    animate(noteElement.value, { opacity: [0, 1], y: [8, 0], duration: 420, delay: 120, ease: 'outBack(1.6)' })
})

const tokenKey = (view: { version?: number }, index: number) => view.version !== undefined ? `v${view.version}` : `none-${index}`

// A token grows in from nothing and shrinks out, and the row closes behind it.
function onEnter(element: Element, done: () => void): void {
  if (!props.animated)
    return done()
  const gap = element.previousElementSibling ? 6 : 0
  animate(element as HTMLElement, { width: [0, 30], marginLeft: [0, gap], scale: [0, 1], opacity: [0, 1], duration: 560, ease: 'outBack(1.4)', onComplete: () => done() })
}

function onLeave(element: Element, done: () => void): void {
  if (!props.animated)
    return done()
  animate(element as HTMLElement, { width: 0, marginLeft: 0, scale: 0.2, opacity: 0, duration: 460, ease: 'inQuad', onComplete: () => done() })
}

// A change of the newest token of a node sends a pulse from its slot. Nodes further down the graph pulse later.
const slotElements = new Map<string, HTMLElement>()
function bindSlot(id: string, element: unknown): void {
  if (element instanceof HTMLElement)
    slotElements.set(id, element)
  else
    slotElements.delete(id)
}

function lastKind(frame: Frame | undefined, id: string): TokenKind | undefined {
  const views = frame?.nodes[id]
  return views?.length ? kindOf(views.at(-1)!) : undefined
}

watch(() => props.frame, async (now, before) => {
  if (!props.animated || !now || !before)
    return
  await nextTick()
  for (const node of props.nodes) {
    const kind = lastKind(now, node.id)
    if (!kind || kind === lastKind(before, node.id))
      continue
    const fill = pulseOf(kind)
    const slot = slotElements.get(node.id)
    if (!fill || !slot)
      continue
    const pulse = document.createElement('span')
    pulse.className = 'pulse'
    pulse.style.background = fill
    slot.prepend(pulse)
    animate(pulse, {
      scale: [0.92, 1.18],
      opacity: [0.95, 0],
      delay: (depth.value.get(node.id) ?? 0) * 170,
      duration: 900,
      ease: 'outQuad',
      onComplete: () => pulse.remove(),
    })
  }
})

const HIGHLIGHT_TEXT: Record<Highlight, string> = { stopped: 'will stop', rebuilt: 'will rebuild', notified: 'handler runs' }

const nextVersion = (views: readonly { version?: number }[]) => Math.max(0, ...views.map(view => view.version ?? 0)) + 1
</script>

<template>
  <div ref="root" class="fit" :class="{ fluid: width === undefined }">
    <div class="stage" :style="{ width: `${designW * scale}px`, height: `${designH * scale}px` }">
      <div class="canvas" :style="{ width: `${designW}px`, height: `${designH}px`, transform: `scale(${scale})` }">
        <div v-for="box in boxRects" :key="box.label" class="box" :style="{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }">
          <span class="box-label mono">{{ box.label }}</span>
        </div>

        <svg class="wires" :width="designW" :height="designH" aria-hidden="true">
          <Wire v-for="wire in wires" :key="wire.id" v-bind="wire" :animated="animated" :dim="dimmed(wire.id.split('->')[0]!) && dimmed(wire.id.split('->')[1]!)" />
        </svg>

        <component
          :is="interactive ? 'button' : 'div'"
          v-for="slot in slots"
          :key="slot.id"
          :ref="(element: unknown) => bindSlot(slot.id, element)"
          class="slot"
          :class="[slot.mood, highlight?.[slot.id] && `hl-${highlight[slot.id]}`, { selected: selected === slot.id, interactive, dim: dimmed(slot.id), lit: focused.has(slot.id) }]"
          :style="{ left: `${slot.left}px`, top: `${slot.top}px`, width: `${NODE_W}px`, height: `${NODE_H}px` }"
          :type="interactive ? 'button' : undefined"
          @click="interactive && emit('select', slot.id)"
        >
          <span class="text">
            <span class="name mono">{{ slot.key }}</span>
            <!-- A preview takes the place of the phase, and stays sharp while the rest of the slot blurs. -->
            <span v-if="highlight?.[slot.id]" class="tag" :class="highlight[slot.id]">{{ HIGHLIGHT_TEXT[highlight[slot.id]!] }}</span>
            <span v-else class="word">{{ slot.word }}</span>
          </span>
          <span class="cluster">
            <TransitionGroup tag="span" class="tokens" :css="false" @enter="onEnter" @leave="onLeave">
              <Token v-for="(view, i) in slot.views" :key="tokenKey(view, i)" :view="view" :animated="animated" />
            </TransitionGroup>
            <!-- A preview: the instance that a rebuild would make. It is not there yet, so it blinks. -->
            <span v-if="highlight?.[slot.id] === 'rebuilt'" class="ghost mono">v{{ nextVersion(slot.views) }}</span>
          </span>
        </component>

        <span
          v-for="(ring, i) in rings"
          :key="i"
          class="ring"
          :class="{ main: i === 0, still: !animated }"
          :style="{ left: `${ring.left}px`, top: `${ring.top}px`, width: `${ring.width}px`, height: `${ring.height}px` }"
          aria-hidden="true"
        />

        <span
          v-if="notePlace"
          :key="`${note}-${focus?.[0]}`"
          ref="noteElement"
          class="note"
          :style="{ left: `${notePlace.left + 14}px`, top: `${notePlace.top - 34}px` }"
        >{{ note }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fit {
  display: flex;
  justify-content: center;
}

.fit.fluid {
  width: 100%;
  min-width: 0;
  align-self: stretch;
}

.stage {
  position: relative;
  flex: none;
}

.canvas {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.box {
  position: absolute;
  border-radius: 24px;
  background: var(--shade);
}

.box-label {
  position: absolute;
  top: -24px;
  left: 6px;
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.04em;
}

.wires {
  position: absolute;
  inset: 0;
  overflow: visible;
}

.slot {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 14px 0 16px;
  border: 0;
  border-radius: 18px;
  background: var(--control);
  isolation: isolate;
  color: inherit;
  font: inherit;
  text-align: left;
  transition:
    background 0.3s,
    opacity 0.3s;
}

.slot :deep(.pulse) {
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
}

.slot.interactive {
  cursor: pointer;
}

.slot.dim {
  opacity: 0.58;
}

/*
 * The focus is a faint ring, not a fill: it slides from node to node with the steps.
 * The main ring breathes a little, so it reads as the place to look.
 */
.ring {
  position: absolute;
  z-index: 1;
  border: 2px solid color-mix(in srgb, var(--ink) 22%, transparent);
  border-radius: 26px;
  pointer-events: none;
  transition:
    left 0.55s cubic-bezier(0.2, 0, 0, 1),
    top 0.55s cubic-bezier(0.2, 0, 0, 1),
    width 0.55s cubic-bezier(0.2, 0, 0, 1),
    height 0.55s cubic-bezier(0.2, 0, 0, 1);
}

.ring.main {
  border-color: color-mix(in srgb, var(--ink) 48%, transparent);
  /* Opacity, not the border color, so the compositor runs it and no frame repaints. */
  animation: breathe-ring 1.8s ease-in-out infinite alternate;
  will-change: opacity;
}

.ring.still {
  animation: none;
  transition: none;
}

@keyframes breathe-ring {
  to {
    opacity: 0.45;
  }
}

.note {
  position: absolute;
  z-index: 2;
  padding: 5px 11px;
  border-radius: 10px 10px 10px 3px;
  background: var(--accent-fill, var(--ink));
  color: var(--on-accent, var(--paper));
  font-size: 13px;
  white-space: nowrap;
  pointer-events: none;
}

.slot.interactive:hover {
  background: var(--control-2);
}

.slot.selected,
.slot.selected:hover {
  background: var(--control-3);
}

.slot.absent {
  background: color-mix(in srgb, var(--control) 45%, transparent);
}

.slot.waiting {
  background: color-mix(in srgb, var(--control) 70%, transparent);
}

.slot.bad {
  background: var(--bad-soft);
}

/*
 * A preview of graph().impact(). Nothing changed yet, so the slot blinks: a unit that would stop blurs out,
 * a unit that would rebuild shows its next instance as a ghost, and a unit with a handler pulses.
 */
.slot.hl-stopped .name,
.slot.hl-stopped .word,
.slot.hl-stopped .tokens {
  filter: blur(1.4px);
  animation: blink 0.9s ease-in-out infinite alternate;
}

.slot.hl-notified {
  animation: breathe 0.9s ease-in-out infinite alternate;
}

.ghost {
  display: grid;
  width: 30px;
  height: 30px;
  margin-left: 6px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--new);
  color: var(--new);
  font-size: 11.5px;
  place-items: center;
  animation: blink 0.9s ease-in-out infinite alternate;
}

@keyframes blink {
  from {
    opacity: 1;
  }

  to {
    opacity: 0.3;
  }
}

@keyframes breathe {
  from {
    background: var(--control);
  }

  to {
    background: var(--control-3);
  }
}

.text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
}

.name {
  overflow: hidden;
  color: var(--ink);
  font-size: 15px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.absent .name,
.waiting .name {
  color: var(--muted);
}

.word {
  overflow: hidden;
  color: var(--muted);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bad .word {
  color: var(--bad);
}

.cluster {
  display: flex;
  flex: none;
  align-items: center;
}

.tokens {
  display: flex;
  flex: none;
  align-items: center;
}

.tokens > :deep(* + *) {
  margin-left: 6px;
}

.tag {
  align-self: flex-start;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--paper);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
}

.tag.stopped {
  background: var(--bad-fill);
}

.tag.rebuilt {
  background: var(--new-fill);
}

.tag.notified {
  background: var(--ink-2);
}
</style>
