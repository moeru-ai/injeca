<script setup lang="ts">
import type { JSAnimation } from 'animejs'

import type { EdgeState } from '../lab/lab'

import { animate } from 'animejs'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * One dependency, from the provider to the consumer. Dots flow along a wire that serves.
 * A dashed wire waits for its provider. A faint dotted wire is not selected now.
 */
const props = defineProps<{
  d: string
  state: EdgeState
  optional: boolean
  end: { x: number, y: number }
  label: { x: number, y: number, anchor: 'start' | 'middle' | 'end' }
  animated: boolean
  /** Neither end is in focus. */
  dim?: boolean
}>()

const flow = ref<SVGPathElement>()
const base = ref<SVGPathElement>()
let loop: JSAnimation | undefined

async function restart(from?: EdgeState): Promise<void> {
  loop?.revert()
  loop = undefined
  await nextTick()
  if (!props.animated)
    return
  if (props.state === 'serving' && flow.value)
    loop = animate(flow.value, { strokeDashoffset: [0, -24], duration: 900, ease: 'linear', loop: true })
  // A wire that starts to serve draws itself in.
  if (from !== undefined && from !== 'serving' && props.state === 'serving' && base.value)
    animate(base.value, { opacity: [0, 1], duration: 500, ease: 'outQuad' })
}

onMounted(() => restart())
watch(() => props.state, (_now, before) => restart(before))
watch(() => props.animated, () => restart())
onBeforeUnmount(() => loop?.revert())
</script>

<template>
  <g class="wire" :class="[state, { optional, dim }]">
    <path ref="base" class="base" :d="d" />
    <path v-if="state === 'serving' && animated" ref="flow" class="flow" :d="d" />
    <circle class="tip" :cx="end.x" :cy="end.y" r="3.5" />
    <text v-if="optional" class="note" :x="label.x" :y="label.y" :text-anchor="label.anchor">
      optional
    </text>
  </g>
</template>

<style scoped>
.wire {
  transition: opacity 0.35s;
}

.wire.dim {
  opacity: 0.3;
}

.base {
  fill: none;
  stroke: var(--line);
  stroke-width: 1.5;
  stroke-dasharray: 1.5 6;
  stroke-linecap: round;
  transition: stroke 0.35s;
}

.serving .base {
  stroke: var(--line-strong);
  stroke-dasharray: none;
}

.serving.optional .base {
  stroke-dasharray: 7 5;
}

.waiting .base {
  stroke: var(--muted);
  stroke-dasharray: 5 6;
}

.flow {
  fill: none;
  stroke: var(--ink);
  stroke-width: 3.5;
  stroke-dasharray: 0.1 23.9;
  stroke-linecap: round;
}

.tip {
  fill: var(--line);
  transition: fill 0.35s;
}

.serving .tip {
  fill: var(--line-strong);
}

.waiting .tip {
  fill: var(--muted);
}

.note {
  fill: var(--muted);
  stroke: var(--surface);
  stroke-width: 5px;
  stroke-linejoin: round;
  paint-order: stroke;
  dominant-baseline: middle;
  font-family: var(--font-mono);
  font-size: 11.5px;
}
</style>
