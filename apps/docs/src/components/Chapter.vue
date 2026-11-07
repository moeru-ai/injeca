<script setup lang="ts">
import type { JSAnimation } from 'animejs'

import type { Scenario } from '../lab/scenarios'

import highlighted from 'virtual:highlighted-samples'

import { animate, stagger } from 'animejs'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import Stage from '../stage/Stage.vue'
import CodeWindow from './CodeWindow.vue'
import Coverage from './Coverage.vue'
import Prose from './Prose.vue'

import { text } from '../i18n'
import { edgesOf } from '../lab/scenarios'
import { framesOf, ready } from '../lab/store'
import { useNear } from '../near'
import { theme } from '../theme'

/**
 * One chapter: what to know, a graph that runs, and the code that runs it.
 * It plays while it is on screen. Choosing another primitive plays that one from the start.
 */
const props = defineProps<{ scenario: Scenario, index: number }>()

/** How long one step shows while the chapter plays. */
const STEP_MS = 3000

const variantIndex = ref(0)
const stepIndex = ref(0)
const playing = ref(false)

const variant = computed(() => props.scenario.variants[variantIndex.value]!)
const frames = computed(() => framesOf(props.scenario, variant.value))
const frame = computed(() => frames.value[stepIndex.value])

/** The text of the chapter in the locale of the page. The English is the default. */
const base = computed(() => `chapters.${props.scenario.id}`)
const local = (path: string, english: string) => text(`${base.value}.${path}`, english)
const step = (i: number) => `variants.${variant.value.id}.steps.${i}`
const code = computed(() => highlighted[theme.value][`${props.scenario.id}/${variant.value.id}`] ?? [])
const atEnd = computed(() => stepIndex.value >= frames.value.length - 1)
const compare = computed(() => props.scenario.variants.length > 1)

// The fill of the current step grows while the chapter plays. At its end, the next step comes.
const fills = ref<HTMLElement[]>([])
let progress: JSAnimation | undefined

async function runProgress(): Promise<void> {
  progress?.cancel()
  progress = undefined
  await nextTick()
  // The classes of the fills show the steps before and after. An inline transform of an earlier run must not hide them.
  for (const element of fills.value)
    element.style.transform = ''
  const fill = fills.value[stepIndex.value]
  if (!playing.value || !fill)
    return
  progress = animate(fill, {
    scaleX: [0, 1],
    duration: STEP_MS,
    ease: 'linear',
    onComplete: () => {
      if (atEnd.value)
        playing.value = false
      else
        stepIndex.value++
    },
  })
}
watch([playing, stepIndex, variantIndex], () => void runProgress())

function play(): void {
  if (atEnd.value)
    stepIndex.value = 0
  playing.value = true
}

function goTo(index: number): void {
  playing.value = false
  stepIndex.value = Math.min(frames.value.length - 1, Math.max(0, index))
}

function selectVariant(index: number): void {
  variantIndex.value = index
  stepIndex.value = 0
  playing.value = true
}

// It plays while at least half of it is on screen, and pauses when it leaves.
const root = ref<HTMLElement>()
/** The loops of the stage run only near the screen. */
const near = useNear(root)
let seen: IntersectionObserver | undefined
let started = false
onMounted(() => {
  void ready.then(() => {
    seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !started) {
        started = true
        playing.value = true
      }
      else if (!entry?.isIntersecting) {
        playing.value = false
      }
    }, { threshold: 0.45 })
    if (root.value)
      seen.observe(root.value)
  })
})
onBeforeUnmount(() => {
  progress?.cancel()
  seen?.disconnect()
})

// A faint ring slides to the chosen primitive, the same ring that marks the focus in the graph.
const options = ref<HTMLElement[]>([])
const indicator = ref<HTMLElement>()
async function moveIndicator(instant = false): Promise<void> {
  await nextTick()
  const target = options.value[variantIndex.value]
  if (!target || !indicator.value)
    return
  animate(indicator.value, { x: target.offsetLeft, y: target.offsetTop, width: target.offsetWidth, height: target.offsetHeight, duration: instant ? 0 : 420, ease: 'outExpo' })
}
watch(variantIndex, () => moveIndicator())
onMounted(() => {
  void moveIndicator(true)
  window.addEventListener('resize', () => moveIndicator(true))
})

// The caption and the calls of a step come in.
const caption = ref<HTMLElement>()
const log = ref<HTMLElement>()
watch([stepIndex, variantIndex], async () => {
  await nextTick()
  if (caption.value)
    animate(caption.value, { opacity: [0, 1], y: [8, 0], duration: 420, ease: 'outCubic' })
  const lines = log.value?.querySelectorAll('li')
  if (lines?.length)
    animate(lines, { opacity: [0, 1], x: [-6, 0], delay: stagger(60, { start: 200 }), duration: 340, ease: 'outCubic' })
})

</script>

<template>
  <section :id="scenario.id" ref="root" class="chapter hue-0" :aria-labelledby="`${scenario.id}-title`">
    <header class="head" data-flash>
      <span class="n mono">{{ String(index + 1).padStart(2, '0') }}</span>
      <h2 :id="`${scenario.id}-title`">
        {{ local('title', scenario.title) }}
      </h2>
      <p v-for="(paragraph, i) in scenario.intro" :key="i" class="intro">
        <Prose :text="local(`intro.${i}`, paragraph)" />
      </p>
    </header>

    <div v-if="compare" class="choose">
      <p class="question">
        {{ local('question', scenario.question ?? '') }}
      </p>
      <div class="primitives" role="tablist" :aria-label="local('question', scenario.question ?? '')">
        <span ref="indicator" class="indicator" aria-hidden="true" />
        <button
          v-for="(v, i) in scenario.variants"
          :key="v.id"
          :ref="(el) => { if (el) options[i] = el as HTMLElement }"
          type="button"
          role="tab"
          class="primitive"
          :class="{ on: i === variantIndex }"
          :aria-selected="i === variantIndex"
          @click="selectVariant(i)"
        >
          <code>{{ v.primitive }}</code>
          <span class="outcome"><i class="dot" :class="v.tone" />{{ local(`variants.${v.id}.outcome`, v.outcome) }}</span>
        </button>
      </div>
    </div>

    <div class="work">
      <div class="stage-col">
        <div class="stage-card">
          <ul v-if="frame?.calls.length" class="calls">
            <li v-for="call in frame.calls" :key="call.label" :class="call.state">
              <code>{{ call.label }}</code>
              <span>{{ $t(`chapter.calls.${call.state}`) }}{{ call.state === 'rejected' && call.detail ? `: ${call.detail}` : '' }}</span>
            </li>
          </ul>
          <Stage
            :nodes="scenario.nodes"
            :boxes="scenario.boxes"
            :edges="edgesOf(scenario, variant)"
            :frame="frame"
            :focus="frame?.focus"
            :note="frame?.note && local(`${step(stepIndex)}.note`, frame.note)"
            :animated="near"
          />
          <Coverage v-if="compare" class="coverage" :nodes="scenario.nodes.map(node => node.id)" :frames="frames" :step="stepIndex" />
        </div>

        <div class="timeline">
          <button type="button" class="pill play" :aria-label="playing ? $t('chapter.pause') : $t('chapter.play')" @click="playing ? (playing = false) : play()">
            <svg v-if="playing" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
            <svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11a.8.8 0 0 0 1.2.7l9-5.5a.8.8 0 0 0 0-1.4l-9-5.5A.8.8 0 0 0 4 2.5Z" /></svg>
            {{ playing ? $t('chapter.pause') : atEnd ? $t('chapter.replay') : $t('chapter.play') }}
          </button>
          <ol class="segments">
            <li v-for="(f, i) in frames" :key="i">
              <button type="button" class="segment" :class="{ done: i < stepIndex, on: i === stepIndex }" :aria-label="$t('chapter.step', { n: i + 1, caption: local(`${step(i)}.caption`, f.caption) })" @click="goTo(i)">
                <span class="track"><span :ref="(el) => { if (el) fills[i] = el as HTMLElement }" class="fill" :class="{ full: i < stepIndex || (i === stepIndex && !playing) }" /></span>
              </button>
            </li>
          </ol>
          <span v-if="frame && frame.time > 0" class="mono clock">{{ frame.time / 1000 }} s</span>
        </div>

        <p ref="caption" class="caption" aria-live="polite">
          <span class="mono step">{{ stepIndex + 1 }}/{{ frames.length }}</span>
          {{ frame && local(`${step(stepIndex)}.caption`, frame.caption) }}
        </p>
      </div>

      <aside class="code-col">
        <CodeWindow :file="scenario.file" :lines="code" :active="frame?.lines" />
        <p class="summary">
          {{ local(`variants.${variant.id}.summary`, variant.summary) }}
        </p>
        <details class="observe">
          <i18n-t keypath="chapter.observe" tag="summary" scope="global">
            <template #observe>
              <code>observe()</code>
            </template>
          </i18n-t>
          <ul v-if="stepIndex > 0 && frame?.log.length" ref="log" class="log mono">
            <li v-for="(line, i) in frame.log" :key="`${variant.id}-${stepIndex}-${i}`" :class="line.tone">
              {{ line.text }}
            </li>
          </ul>
          <i18n-t v-else-if="stepIndex === 0" keypath="chapter.first-step" tag="p" class="quiet" scope="global">
            <template #start>
              <code>start()</code>
            </template>
          </i18n-t>
          <p v-else class="quiet">
            {{ $t('chapter.no-records') }}
          </p>
        </details>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.chapter {
  padding: 96px 0 0;
  scroll-margin-top: 24px;
}

.head {
  max-width: 760px;
}

.n {
  color: var(--accent);
  font-size: 13px;
}

h2 {
  margin: 8px 0 0;
  font-size: 40px;
  font-weight: 400;
  letter-spacing: -0.01em;
  line-height: 1.12;
  text-wrap: balance;
}

.intro {
  margin: 14px 0 0;
  color: var(--ink-2);
  font-size: 18px;
  line-height: 1.6;
}

.choose {
  margin-top: 30px;
}

.question {
  margin: 0;
  font-family: var(--font-display);
  font-size: 21px;
}

.primitives {
  position: relative;
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 14px;
  padding: 4px;
  border-radius: 22px;
  background: var(--control);
}

.indicator {
  position: absolute;
  top: 0;
  left: 0;
  border: 2px solid color-mix(in srgb, var(--ink) 38%, transparent);
  border-radius: 18px;
  background: var(--knob);
}

.primitive {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 9px 16px;
  border: 0;
  border-radius: 18px;
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
  text-align: left;
  transition: color 0.25s;
}

.primitive code {
  font-size: 13.5px;
}

.primitive.on {
  color: var(--ink);
}

/* The outcome is plain text. Only its dot has the color of the result: green works, red stops, grey has a catch. */
.outcome {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--ink-2);
  font-size: 13px;
}

.dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
}

.dot.good {
  background: var(--good-fill);
}

.dot.bad {
  background: var(--bad-fill);
}

.dot.warn {
  background: var(--muted);
}

.work {
  display: grid;
  gap: 32px;
  margin-top: 24px;
  grid-template-columns: minmax(0, 1fr) 360px;
}

.stage-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 56px 24px 24px;
  border-radius: 28px;
  background: var(--surface);
}

.calls {
  position: absolute;
  top: 16px;
  right: 20px;
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.calls li {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 11px;
  border-radius: 999px;
  background: var(--control);
  color: var(--muted);
  font-size: 13px;
}

.calls code {
  color: var(--ink);
  font-size: 12.5px;
}

.calls .resolved span {
  color: var(--good);
}

.calls .rejected span {
  color: var(--bad);
}

.calls .waiting span {
  animation: wait 1s ease-in-out infinite alternate;
}

@keyframes wait {
  to {
    opacity: 0.35;
  }
}

.coverage {
  padding: 0 8px;
}

.timeline {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
}

.play {
  flex: none;
  min-width: 108px;
  justify-content: center;
  background: var(--accent-fill);
  color: var(--on-accent);
}

.play:hover {
  background: var(--accent);
}

.play svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
}

.segments {
  display: flex;
  flex: 1;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.segments li {
  flex: 1;
}

.segment {
  display: block;
  width: 100%;
  padding: 10px 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.track {
  display: block;
  overflow: hidden;
  height: 5px;
  border-radius: 999px;
  background: var(--control-2);
}

.fill {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--accent-fill);
  transform: scaleX(0);
  transform-origin: 0 50%;
}

.fill.full {
  transform: scaleX(1);
}

.clock {
  flex: none;
  color: var(--muted);
  font-size: 13px;
}

.caption {
  min-height: 3em;
  margin: 14px 0 0;
  font-size: 20px;
  line-height: 1.45;
}

.step {
  margin-right: 8px;
  color: var(--faint);
  font-size: 12px;
}

.code-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.summary {
  margin: 0;
  color: var(--ink-2);
  font-size: 15.5px;
  line-height: 1.55;
}

.observe {
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--surface);
  color: var(--muted);
  font-size: 14px;
}

.observe summary {
  cursor: pointer;
}

.observe code {
  font-size: 13px;
}

.log {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 12px 0 2px;
  padding: 0;
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.45;
  list-style: none;
}

.log li.bad {
  color: var(--bad);
}

.quiet {
  margin: 10px 0 0;
  font-size: 13px;
}

@media (max-width: 1100px) {
  .work {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  h2 {
    font-size: 30px;
  }

  .primitives {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .stage-card {
    padding: 56px 8px 16px;
  }

  .timeline {
    flex-wrap: wrap;
  }

  .caption {
    font-size: 18px;
  }
}
</style>
