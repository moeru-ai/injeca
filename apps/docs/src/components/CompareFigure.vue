<script setup lang="ts">
import type { Scenario } from '../lab/scenarios'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import Stage from '../stage/Stage.vue'

import { edgesOf } from '../lab/scenarios'
import { framesOf, ready } from '../lab/store'

/**
 * The README figure of one chapter, as an animated banner at about 2.8:1. It plays each primitive in turn, the way the
 * chapter of the lab does: the real graph at each step that the lab recorded, with the note of the step and its
 * caption. The list on the left shows which primitive plays, and what it leads to.
 *
 * The banner script drives it: `__captureFrames` holds how long each frame shows, and `__captureAt(i)` draws frame
 * `i`. Opened in a browser, it plays on its own.
 */
const props = defineProps<{ scenario: Scenario, number: number }>()

/** How long a step shows, and the last step of a primitive, so its outcome can sink in. */
const STEP_MS = 1800
const LAST_MS = 3000

const sequence = computed(() => props.scenario.variants.flatMap((variant, v) => {
  const frames = framesOf(props.scenario, variant)
  return frames.map((frame, s) => ({ v, s, frame, last: s === frames.length - 1 }))
}))

const index = ref(0)
const current = computed(() => sequence.value[index.value % Math.max(1, sequence.value.length)])
const variant = computed(() => props.scenario.variants[current.value?.v ?? 0]!)
const steps = computed(() => framesOf(props.scenario, variant.value).length)

let driven = false
let timer: ReturnType<typeof setTimeout> | undefined
function play(): void {
  if (driven || !current.value)
    return
  timer = setTimeout(() => {
    index.value = (index.value + 1) % sequence.value.length
    play()
  }, current.value.last ? LAST_MS : STEP_MS)
}

type Target = Window & { __captureFrames?: number[], __captureAt?: (i: number) => void }
onMounted(() => {
  const target = window as Target
  target.__captureAt = (i: number) => {
    driven = true
    clearTimeout(timer)
    index.value = i
  }
  void ready.then(() => {
    target.__captureFrames = sequence.value.map(step => (step.last ? LAST_MS : STEP_MS))
    play()
  })
})
onBeforeUnmount(() => clearTimeout(timer))
watch(() => props.scenario, () => (index.value = 0))
</script>

<template>
  <div class="compare" role="img" :aria-label="`${scenario.question} ${scenario.variants.map(v => `${v.primitive}: ${v.outcome}.`).join(' ')}`">
    <div class="left">
      <span class="n mono">{{ String(number).padStart(2, '0') }}</span>
      <p class="title">
        {{ scenario.title }}
      </p>
      <p class="question">
        {{ scenario.question }}
      </p>
      <ol class="variants">
        <li v-for="(v, i) in scenario.variants" :key="v.id" class="variant" :class="{ on: i === current?.v }">
          <code>{{ v.primitive }}</code>
          <span class="outcome"><i class="dot" :class="v.tone" />{{ v.outcome }}</span>
        </li>
      </ol>
    </div>
    <div class="right">
      <div class="stage">
        <Stage
          v-if="current"
          :nodes="scenario.nodes"
          :boxes="scenario.boxes"
          :edges="edgesOf(scenario, variant)"
          :frame="current.frame"
          :focus="current.frame.focus"
          :note="current.frame.note"
          :width="840"
          :height="300"
          :animated="false"
        />
      </div>
      <p v-if="current" class="caption">
        <span class="dots" aria-hidden="true">
          <i v-for="s in steps" :key="s" :class="{ done: s - 1 < current.s, on: s - 1 === current.s }" />
        </span>
        <span class="text">{{ current.frame.caption }}</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.compare {
  display: grid;
  overflow: hidden;
  width: 1440px;
  height: 520px;
  align-items: center;
  gap: 48px;
  padding: 0 56px;
  border-radius: 32px;
  background: var(--paper);
  grid-template-columns: 400px minmax(0, 1fr);
}

.n {
  color: var(--new);
  font-size: 13px;
}

.title {
  margin: 8px 0 0;
  font-family: var(--font-display);
  font-size: 30px;
  line-height: 1.15;
}

.question {
  margin: 12px 0 0;
  color: var(--ink-2);
  font-size: 17px;
  line-height: 1.45;
}

.variants {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 24px 0 0;
  padding: 0;
  list-style: none;
}

.variant {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px;
  border-radius: 14px;
  opacity: 0.45;
}

.variant.on {
  background: var(--control);
  opacity: 1;
}

.variant code {
  font-size: 14px;
}

.outcome {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--ink-2);
  font-size: 14px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--faint);
}

.dot.good {
  background: var(--good);
}

.dot.bad {
  background: var(--bad);
}

.right {
  display: flex;
  height: 440px;
  flex-direction: column;
  justify-content: space-between;
  padding: 28px 32px 24px;
  border-radius: 24px;
  background: var(--surface);
}

.stage {
  display: grid;
  flex: 1;
  place-items: center;
}

.caption {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
}

.dots {
  display: flex;
  flex: none;
  gap: 5px;
}

.dots i {
  width: 18px;
  height: 4px;
  border-radius: 2px;
  background: var(--control-2);
}

.dots i.done {
  background: var(--ink-2);
}

.dots i.on {
  background: var(--new);
}

.text {
  color: var(--ink);
}
</style>
