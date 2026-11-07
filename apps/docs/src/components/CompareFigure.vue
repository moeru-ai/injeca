<script setup lang="ts">
import type { Scenario } from '../lab/scenarios'

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import Stage from '../stage/Stage.vue'

import { edgesOf } from '../lab/scenarios'
import { framesOf, ready } from '../lab/store'

/**
 * The README figure of one chapter, as an animated banner at about 3:1. It plays each primitive in turn, the way the
 * chapter of the lab does: the real graph at each step that the lab recorded, with its transitions, the note of the
 * step, and a caption of what happens now. The tabs on top show which primitive plays, and what it leads to.
 *
 * The banner script drives it: `__captureFrames` holds how long each step shows, `__captureAt(i)` moves to step `i`,
 * and the script records the transitions in between on virtual time, at `__captureFps` frames a second. Opened in a
 * browser, it plays on its own.
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
  ;(target as Target & { __captureFps?: number }).__captureFps = 15
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
    <ol class="variants">
      <li v-for="(v, i) in scenario.variants" :key="v.id" class="variant" :class="{ on: i === current?.v }">
        <code>{{ v.primitive }}</code>
        <span class="outcome"><i class="dot" :class="v.tone" />{{ v.outcome }}</span>
      </li>
    </ol>
    <div class="stage">
      <Stage
        v-if="current"
        :nodes="scenario.nodes"
        :boxes="scenario.boxes"
        :edges="edgesOf(scenario, variant)"
        :frame="current.frame"
        :focus="current.frame.focus"
        :note="current.frame.note"
        :width="1000"
        :height="250"
      />
    </div>
    <p v-if="current" class="caption">
      <span class="dots" aria-hidden="true">
        <i v-for="s in steps" :key="s" :class="{ done: s - 1 < current.s, on: s - 1 === current.s }" />
      </span>
      <Transition name="caption" mode="out-in">
        <span :key="index" class="text">{{ current.frame.caption }}</span>
      </Transition>
    </p>
  </div>
</template>

<style scoped>
.compare {
  display: flex;
  overflow: hidden;
  width: 1440px;
  height: 480px;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 36px 56px 34px;
  border-radius: 32px;
  background: var(--paper);
}

/* The primitives, as tabs. The one that plays has a fill, and the others step back. */
.variants {
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 5px;
  border-radius: 18px;
  background: var(--control);
  list-style: none;
}

.variant {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 16px;
  border-radius: 13px;
  opacity: 0.5;
  transition:
    background 0.3s,
    opacity 0.3s;
}

.variant.on {
  background: var(--knob);
  opacity: 1;
}

.variant code {
  font-size: 15px;
}

.outcome {
  display: inline-flex;
  align-items: center;
  gap: 7px;
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

.stage {
  display: grid;
  width: 100%;
  flex: 1;
  place-items: center;
}

.caption {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 0;
  font-size: 19px;
  line-height: 1.4;
}

.dots {
  display: flex;
  flex: none;
  gap: 5px;
}

.dots i {
  width: 20px;
  height: 4px;
  border-radius: 2px;
  background: var(--control-2);
  transition: background 0.3s;
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

.caption-enter-active,
.caption-leave-active {
  transition:
    opacity 0.25s,
    transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}

.caption-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.caption-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
