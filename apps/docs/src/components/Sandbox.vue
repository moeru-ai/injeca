<script setup lang="ts">
import type { BuildContext, GraphUnit, ImpactChange } from 'injeca'

import type { Frame, Lab, LabEdge, LogLine } from '../lab/lab'
import type { ScenarioNode } from '../lab/scenarios'
import type { Highlight } from '../stage/Stage.vue'

import { animate } from 'animejs'
import { dispose, graph, optional, provide } from 'injeca'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import Stage from '../stage/Stage.vue'

import { createLab, nodeIdOf } from '../lab/lab'
import { useNear } from '../near'

// The sandbox runs a live container on the real clock. Each build takes a moment and each start hook too,
// so a replacement, a rebuild, and a withdrawal stay on screen long enough to see.
// The graph is yours to change: add a unit, or add and remove the dependencies of one. A change of the
// dependencies of a running unit is a replace() with the new definition, as it would be in an app.

const BUILD_MS = 900
const START_MS = 500

type Key = string
type Status = 'ready' | 'degraded' | 'unavailable'
type Need = 'required' | 'optional'

/** The units and what each one needs. It starts as a small app, and the reader edits it. */
const START: readonly (readonly [Key, readonly (readonly [Key, Need])[]])[] = [
  ['llm', []],
  ['tts', []],
  ['chat', [['llm', 'required']]],
  ['speech', [['tts', 'required'], ['llm', 'optional']]],
  ['app', [['chat', 'required'], ['speech', 'required']]],
]
const needs = reactive(new Map<Key, Map<Key, Need>>())
function seed(): void {
  needs.clear()
  for (const [key, list] of START)
    needs.set(key, new Map(list))
}
seed()

/** How deep a unit sits: 0 without dependencies, else one more than its deepest dependency. */
function levelOf(key: Key, seen = new Set<Key>()): number {
  if (seen.has(key))
    return 0
  seen.add(key)
  const deps = [...(needs.get(key)?.keys() ?? [])]
  return deps.length === 0 ? 0 : 1 + Math.max(...deps.map(dep => levelOf(dep, new Set(seen))))
}

/** The layout: a column for each level, and the units of a level centered in it. */
const NODES = computed<ScenarioNode[]>(() => {
  const columns = new Map<number, Key[]>()
  for (const key of needs.keys())
    columns.set(levelOf(key), [...(columns.get(levelOf(key)) ?? []), key])
  const tallest = Math.max(...[...columns.values()].map(column => column.length))
  return [...columns.entries()].flatMap(([level, keys]) => keys.map((id, i) => ({ id, x: level, y: i + (tallest - keys.length) / 2 })))
})
const EDGES = computed<LabEdge[]>(() => [...needs.entries()].flatMap(([from, deps]) => [...deps.entries()].map(([to, need]) => ({ from, to, ...(need === 'optional' ? { optional: true } : {}) }))))

/** Tells whether `from` can depend on `to` without a cycle: `to` must not need `from`, near or far. */
function canNeed(from: Key, to: Key): boolean {
  const reach = (key: Key, seen = new Set<Key>()): boolean => {
    if (key === from)
      return true
    if (seen.has(key))
      return false
    seen.add(key)
    return [...(needs.get(key)?.keys() ?? [])].some(dep => reach(dep, seen))
  }
  return from !== to && !reach(to)
}

const dependsOnOf = (key: Key) => Object.fromEntries([...(needs.get(key) ?? [])].map(([dep, need]) => [dep, need === 'optional' ? optional(dep) : dep]))

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

let lab: Lab
let stopListening: (() => void) | undefined
/** What the sandbox needs of the result of `provide`. The definitions are dynamic, so the keys have no types. */
interface Handle {
  readonly replace: (option: any) => Promise<boolean>
  readonly withdraw: () => Promise<boolean>
}

const registrations = new Map<Key, Handle>()
const setters = new Map<Key, (status: Status) => void>()
/** The units that register a `dependency-change` handler in their next build. */
const handlers = reactive(new Set<Key>())
/** The units that have a registration now. */
const present = reactive(new Set<Key>())

const frame = shallowRef<Frame>()
const section = ref<HTMLElement>()
/** The loops of the stage run only near the screen. */
const near = useNear(section)
const selected = ref<Key>()
const logList = ref<HTMLElement>()
const log = ref<(LogLine & { id: number })[]>([])
let logId = 0

function options(key: Key, fail = false) {
  return {
    dependsOn: dependsOnOf(key),
    build: async ({ on, setStatus }: BuildContext<any>) => {
      await sleep(BUILD_MS)
      if (fail)
        throw new Error(`The new build of ${key} failed.`)
      setters.set(key, (status: Status) => setStatus(status, { reason: 'from the sandbox' }))
      on('start', () => sleep(START_MS))
      if (handlers.has(key))
        on('dependency-change', ({ decide }) => decide.handled())
      return {}
    },
  }
}

function note(text: string, tone: LogLine['tone'] = 'quiet'): void {
  log.value = [{ id: logId++, node: '', text, tone }, ...log.value].slice(0, 40)
}

let scheduled = false
function redraw(): void {
  if (scheduled)
    return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    const next = lab.snapshot()
    frame.value = next
    if (next.log.length) {
      log.value = [...next.log.map(line => ({ ...line, id: logId++ })).reverse(), ...log.value].slice(0, 40)
      void nextTick(() => {
        const fresh = logList.value?.querySelectorAll('li.fresh')
        if (fresh?.length)
          animate(fresh, { opacity: [0, 1], x: [-8, 0], duration: 360, ease: 'outCubic' })
        fresh?.forEach(element => element.classList.remove('fresh'))
      })
    }
  })
}

function boot(): void {
  lab = createLab(EDGES.value, { clock: 'system' })
  registrations.clear()
  setters.clear()
  present.clear()
  for (const key of needs.keys()) {
    registrations.set(key, provide(lab.host, key, options(key) as any) as unknown as Handle)
    present.add(key)
  }
  stopListening = lab.onChange(redraw)
  lab.start()
  redraw()
}

async function reset(): Promise<void> {
  stopListening?.()
  const old = lab
  selected.value = undefined
  handlers.clear()
  log.value = []
  seed()
  boot()
  await dispose(old.host).catch(() => {})
}

onMounted(boot)
onBeforeUnmount(() => {
  stopListening?.()
  void dispose(lab.host).catch(() => {})
})

const { t } = useI18n()

const selectedViews = computed(() => (selected.value && frame.value?.nodes[selected.value]) || [])
const running = computed(() => selectedViews.value.some(view => view.phase === 'running'))

async function act(label: string, run: () => Promise<unknown> | unknown): Promise<void> {
  note(label, 'new')
  try {
    const result = await run()
    if (result === false)
      note(t('sandbox.log.superseded', { label }), 'quiet')
  }
  catch (error) {
    note(t('sandbox.log.rejected', { label, error: error instanceof Error ? error.message : String(error) }), 'bad')
  }
}

function replace(key: Key, fail = false): void {
  void act(`${key}.replace(${fail ? t('sandbox.log.failing') : ''})`, () => registrations.get(key)!.replace(options(key, fail)))
}

function withdraw(key: Key): void {
  void act(`${key}.withdraw()`, async () => {
    const result = await registrations.get(key)!.withdraw()
    present.delete(key)
    return result
  })
}

function provideAgain(key: Key): void {
  void act(`provide('${key}')`, () => {
    registrations.set(key, provide(lab.host, key, options(key) as any) as unknown as Handle)
    present.add(key)
  })
}

function setStatus(key: Key, status: Status): void {
  void act(`${key}: setStatus('${status}')`, () => setters.get(key)?.(status))
}

/** A handler takes effect at the next build, so the toggle replaces the unit with the new definition. */
function toggleHandler(key: Key): void {
  if (handlers.has(key))
    handlers.delete(key)
  else
    handlers.add(key)
  void act(t(handlers.has(key) ? 'sandbox.log.with-handler' : 'sandbox.log.without-handler', { call: `${key}.replace()` }), () => registrations.get(key)!.replace(options(key)))
}

// The lab draws the edges of the graph as it is now.
watch(EDGES, (edges) => {
  lab?.setEdges(edges)
  redraw()
})

/** Cycles a dependency of `key` on `dep`: none, then required, then optional. A running unit gets the new definition by replace(). */
function cycleNeed(key: Key, dep: Key): void {
  const deps = needs.get(key)!
  const now = deps.get(dep)
  if (!now && !canNeed(key, dep))
    return
  if (!now)
    deps.set(dep, 'required')
  else if (now === 'required')
    deps.set(dep, 'optional')
  else
    deps.delete(dep)
  const kind = deps.has(dep) ? t(`sandbox.need.${deps.get(dep)}`) : undefined
  if (present.has(key))
    void act(kind ? t('sandbox.log.with-need', { call: `${key}.replace()`, kind, dep }) : t('sandbox.log.without-need', { call: `${key}.replace()`, dep }), () => registrations.get(key)!.replace(options(key)))
  else
    note(kind ? t('sandbox.log.not-registered-need', { key, kind, dep }) : t('sandbox.log.not-registered-none', { key, dep }))
}

// Adding a unit: a name, and what it needs.
const draftName = ref('')
const draftNeeds = reactive(new Map<Key, Need>())
const draftError = computed(() => {
  const name = draftName.value.trim()
  if (!name)
    return undefined
  if (!/^[a-z][\w-]*$/.test(name))
    return t('sandbox.add.bad-name')
  if (needs.has(name))
    return t('sandbox.add.taken', { name })
  return undefined
})

function cycleDraft(dep: Key): void {
  const now = draftNeeds.get(dep)
  if (!now)
    draftNeeds.set(dep, 'required')
  else if (now === 'required')
    draftNeeds.set(dep, 'optional')
  else
    draftNeeds.delete(dep)
}

function addUnit(): void {
  const name = draftName.value.trim()
  if (!name || draftError.value)
    return
  needs.set(name, new Map(draftNeeds))
  void act(`provide('${name}')`, () => {
    registrations.set(name, provide(lab.host, name, options(name) as any) as unknown as Handle)
    present.add(name)
  })
  selected.value = name
  draftName.value = ''
  draftNeeds.clear()
}

// A preview of a change, from graph().impact(): which units stop, rebuild, or get a handler call.
const preview = ref<{ kind: ImpactChange['kind'], key: Key }>()
const impact = computed(() => {
  if (!preview.value || !frame.value)
    return undefined
  try {
    return graph(lab.host).impact({ kind: preview.value.kind as 'withdraw' | 'replace', key: preview.value.key })
  }
  catch {
    return undefined
  }
})

const highlight = computed<Record<string, Highlight> | undefined>(() => {
  if (!impact.value || !preview.value)
    return undefined
  const map: Record<string, Highlight> = {}
  const mark = (units: readonly GraphUnit[], as: Highlight) => {
    for (const unit of units)
      map[nodeIdOf(unit.owner, unit.key)] = as
  }
  mark(impact.value.notified, 'notified')
  mark(impact.value.rebuilt, 'rebuilt')
  mark(impact.value.stopped, 'stopped')
  if (preview.value.kind === 'replace' && !map[preview.value.key])
    map[preview.value.key] = 'rebuilt'
  return map
})

function names(units: readonly GraphUnit[]): string {
  const list = units.map(unit => unit.key)
  return list.length <= 1 ? list.join('') : t('sandbox.impact.and', { list: list.slice(0, -1).join(', '), last: list.at(-1) })
}

const impactText = computed(() => {
  if (!impact.value || !preview.value)
    return undefined
  const { stopped, rebuilt, notified } = impact.value
  const parts: string[] = []
  if (stopped.length)
    parts.push(t('sandbox.impact.stops', { names: names(stopped) }, stopped.length))
  if (rebuilt.length)
    parts.push(t('sandbox.impact.rebuilds', { names: names(rebuilt) }, rebuilt.length))
  if (notified.length)
    parts.push(t('sandbox.impact.notified', { names: names(notified) }, notified.length))
  const call = `${preview.value.key}.${preview.value.kind}()`
  return parts.length ? t('sandbox.impact.sentence', { call, parts: parts.join(t('sandbox.impact.separator')) }) : t('sandbox.impact.nothing', { call })
})
</script>

<template>
  <section id="sandbox" ref="section" class="sandbox hue-0" aria-labelledby="sandbox-title">
    <div class="head" data-flash>
      <h2 id="sandbox-title">
        {{ $t('sandbox.title') }}
      </h2>
      <p class="intro">
        {{ $t('sandbox.intro') }}
      </p>
    </div>

    <div class="body">
      <div class="stage-wrap">
        <Stage
          :nodes="NODES"
          :edges="EDGES"
          :frame="frame"
          interactive
          :animated="near"
          :selected="selected"
          :highlight="highlight"
          @select="(id) => (selected = id as Key)"
        />
        <p class="legend">
          <span><i class="dot ink" />{{ $t('sandbox.legend.serves') }}</span>
          <span><i class="dot new" />{{ $t('sandbox.legend.builds') }}</span>
          <span><i class="dot degraded" />{{ $t('sandbox.legend.degraded') }}</span>
          <span><i class="dot bad" />{{ $t('sandbox.legend.bad') }}</span>
          <span><i class="dot hollow" />{{ $t('sandbox.legend.waits') }}</span>
        </p>
      </div>

      <aside class="side">
        <div class="panel actions">
          <template v-if="selected">
            <p class="eyebrow">
              {{ $t('sandbox.selected') }}
            </p>
            <p class="title mono">
              {{ selected }}
            </p>

            <p class="impact" :class="{ on: impactText }">
              {{ impactText ?? $t('sandbox.preview') }}
            </p>

            <div v-if="present.has(selected)" class="group">
              <p class="label">
                {{ $t('sandbox.groups.swap') }}
              </p>
              <div class="row">
                <button type="button" class="pill" @mouseenter="preview = { kind: 'replace', key: selected }" @mouseleave="preview = undefined" @focus="preview = { kind: 'replace', key: selected }" @blur="preview = undefined" @click="replace(selected)">
                  <code>replace()</code>
                </button>
                <button type="button" class="pill" @mouseenter="preview = { kind: 'replace', key: selected }" @mouseleave="preview = undefined" @click="replace(selected, true)">
                  <i18n-t keypath="sandbox.failing" scope="global">
                    <template #call>
                      <code>replace()</code>
                    </template>
                  </i18n-t>
                </button>
              </div>
            </div>

            <div class="group">
              <p class="label">
                {{ $t('sandbox.groups.registration') }}
              </p>
              <div class="row">
                <button v-if="present.has(selected)" type="button" class="pill" @mouseenter="preview = { kind: 'withdraw', key: selected }" @mouseleave="preview = undefined" @focus="preview = { kind: 'withdraw', key: selected }" @blur="preview = undefined" @click="withdraw(selected)">
                  <code>withdraw()</code>
                </button>
                <button v-else type="button" class="pill ink" @click="provideAgain(selected)">
                  <i18n-t keypath="sandbox.again" scope="global">
                    <template #call>
                      <code>provide()</code>
                    </template>
                  </i18n-t>
                </button>
              </div>
            </div>

            <div v-if="present.has(selected)" class="group">
              <p class="label">
                {{ $t('sandbox.groups.status') }}
              </p>
              <div class="row">
                <button v-for="status in (['ready', 'degraded', 'unavailable'] as const)" :key="status" type="button" class="pill" :disabled="!running" @click="setStatus(selected, status)">
                  <i class="dot" :class="{ ready: 'ink', degraded: 'degraded', unavailable: 'bad' }[status]" />{{ status }}
                </button>
              </div>
            </div>

            <div class="group">
              <p class="label">
                {{ $t('sandbox.groups.needs') }}
              </p>
              <div class="row">
                <button
                  v-for="other in [...needs.keys()].filter(key => key !== selected)"
                  :key="other"
                  type="button"
                  class="pill need"
                  :class="needs.get(selected)?.get(other)"
                  :disabled="!needs.get(selected)?.has(other) && !canNeed(selected, other)"
                  :title="!needs.get(selected)?.has(other) && !canNeed(selected, other) ? $t('sandbox.cycle', { other, key: selected }) : undefined"
                  @mouseenter="present.has(selected) && (preview = { kind: 'replace', key: selected })"
                  @mouseleave="preview = undefined"
                  @click="cycleNeed(selected, other)"
                >
                  <code>{{ other }}</code>
                  <span v-if="needs.get(selected)?.has(other)" class="kind">{{ $t(`sandbox.need.${needs.get(selected)?.get(other)}`) }}</span>
                </button>
              </div>
              <i18n-t keypath="sandbox.needs-hint" tag="p" class="hint" scope="global">
                <template #replace>
                  <code>replace()</code>
                </template>
              </i18n-t>
            </div>

            <div v-if="(needs.get(selected)?.size ?? 0) > 0 && present.has(selected)" class="group">
              <p class="label">
                {{ $t('sandbox.groups.handler') }}
              </p>
              <button type="button" class="switch" :class="{ on: handlers.has(selected) }" @click="toggleHandler(selected)">
                <span class="knob" />
                <code>on('dependency-change')</code>
              </button>
              <p class="hint">
                {{ $t('sandbox.handler-hint', { key: selected }) }}
              </p>
            </div>
          </template>
          <p v-else class="empty">
            {{ $t('sandbox.pick') }}
          </p>
        </div>

        <form class="panel add" @submit.prevent="addUnit">
          <p class="eyebrow">
            {{ $t('sandbox.add.title') }}
          </p>
          <input v-model="draftName" class="name mono" :placeholder="$t('sandbox.add.placeholder')" :aria-label="$t('sandbox.add.name')" spellcheck="false">
          <p v-if="draftError" class="error">
            {{ draftError }}
          </p>
          <p class="label">
            {{ $t('sandbox.add.needs') }}
          </p>
          <div class="row">
            <button v-for="other in needs.keys()" :key="other" type="button" class="pill need" :class="draftNeeds.get(other)" @click="cycleDraft(other)">
              <code>{{ other }}</code>
              <span v-if="draftNeeds.has(other)" class="kind">{{ $t(`sandbox.need.${draftNeeds.get(other)}`) }}</span>
            </button>
          </div>
          <button type="submit" class="pill ink submit" :disabled="!draftName.trim() || !!draftError">
            <code>provide('{{ draftName.trim() || '…' }}')</code>
          </button>
        </form>

        <div class="panel">
          <div class="log-head">
            <p class="eyebrow">
              observe()
            </p>
            <button type="button" class="reset" @click="reset">
              {{ $t('sandbox.reset') }}
            </button>
          </div>
          <ul ref="logList" class="log mono">
            <li v-for="line in log" :key="line.id" class="fresh" :class="line.tone">
              {{ line.text }}
            </li>
          </ul>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.sandbox {
  padding-top: 120px;
  scroll-margin-top: 24px;
}

.n {
  color: var(--accent);
  font-size: 13px;
}

.head h2 {
  margin: 8px 0 0;
  font-size: 40px;
  font-weight: 400;
  letter-spacing: -0.01em;
  line-height: 1.1;
}

.intro {
  max-width: 720px;
  margin: 14px 0 0;
  color: var(--ink-2);
  font-size: 18px;
  line-height: 1.6;
}

.body {
  display: grid;
  gap: 48px;
  margin-top: 40px;
  grid-template-columns: minmax(0, 1fr) 340px;
}

.stage-wrap {
  align-self: start;
  padding: 40px 24px 24px;
  border-radius: 28px;
  background: var(--surface);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px 20px;
  margin: 28px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.dot.ink {
  background: var(--ink);
}

.dot.new {
  background: var(--new-fill);
}

.dot.degraded {
  background: var(--degraded-fill);
}

.dot.bad {
  background: var(--bad-fill);
}

.dot.hollow {
  box-shadow: inset 0 0 0 1.5px var(--faint);
}

.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel {
  padding: 20px 22px;
  border-radius: 22px;
  background: var(--surface);
}

.title {
  margin: 6px 0 0;
  font-size: 22px;
  font-weight: 500;
}

.impact {
  min-height: 3em;
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.45;
}

.impact.on {
  color: var(--ink);
}

.group {
  margin-top: 18px;
}

.label {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 13px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.row .pill {
  min-height: 36px;
  padding: 0 14px;
  background: var(--control);
  font-size: 14px;
}

.row .pill:hover {
  background: var(--control-2);
}

.row .pill.ink {
  background: var(--ink);
}

.row code {
  font-size: 13px;
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
}

.switch code {
  font-size: 13px;
}

.knob {
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background: var(--control-3);
  transition: background 0.2s;
}

.knob::after {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--knob);
  content: '';
  transition: transform 0.25s;
}

.switch.on .knob {
  background: var(--ink);
}

.switch.on .knob::after {
  transform: translateX(16px);
}

.need .kind {
  color: var(--muted);
  font-size: 12px;
}

.need.required {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 45%, transparent);
}

.need.optional {
  outline: 2px dashed color-mix(in srgb, var(--ink) 40%, transparent);
  outline-offset: -2px;
}

.add {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.add .label {
  margin: 4px 0 0;
}

.name {
  padding: 10px 14px;
  border: 0;
  border-radius: 12px;
  background: var(--control);
  color: var(--ink);
  font-size: 14px;
  outline: none;
}

.name:focus-visible {
  box-shadow: inset 0 0 0 2px var(--new);
}

.error {
  margin: 0;
  color: var(--bad);
  font-size: 13px;
}

.submit {
  align-self: flex-start;
  margin-top: 4px;
}

.hint {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
}

.empty {
  margin: 0;
  color: var(--muted);
}

.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.reset {
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  background: var(--control);
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
}

.log {
  display: flex;
  overflow-y: auto;
  max-height: 280px;
  flex-direction: column;
  gap: 6px;
  margin: 14px 0 0;
  padding: 0;
  font-size: 12.5px;
  line-height: 1.45;
  list-style: none;
}

.log li {
  display: flex;
  gap: 9px;
  color: var(--ink-2);
}

.log li::before {
  width: 7px;
  height: 7px;
  flex: none;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--faint);
  content: '';
}

.log li.good::before {
  background: var(--ink);
}

.log li.activity::before,
.log li.new::before {
  background: var(--new-fill);
}

.log li.new {
  color: var(--ink);
  font-weight: 500;
}

.log li.bad::before {
  background: var(--bad-fill);
}

@media (max-width: 1100px) {
  .body {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .sandbox {
    padding-top: 96px;
  }

  .head h2 {
    font-size: 32px;
  }

  .stage-wrap {
    padding: 28px 8px 20px;
  }
}
</style>
