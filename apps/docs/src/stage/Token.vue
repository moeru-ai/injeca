<script setup lang="ts">
import type { JSAnimation } from 'animejs'

import type { InstanceView } from '../lab/lab'

import { animate } from 'animejs'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { kindOf, wordOf } from './look'

/** One instance: a disc with its version. A ring turns while it builds or starts. A conflict shakes. */
const props = defineProps<{ view: InstanceView, animated: boolean }>()

const kind = computed(() => kindOf(props.view))
const label = computed(() => props.view.version !== undefined ? `v${props.view.version}` : kind.value === 'failed' || kind.value === 'conflict' ? '×' : '')

const root = ref<HTMLElement>()
const ring = ref<SVGSVGElement>()
let loop: JSAnimation | undefined

function restart(): void {
  loop?.revert()
  loop = undefined
  if (!props.animated)
    return
  if (kind.value === 'building' || kind.value === 'starting' || kind.value === 'retrying')
    loop = animate(ring.value!, { rotate: 360, duration: kind.value === 'retrying' ? 2600 : 1100, ease: 'linear', loop: true })
  else if (kind.value === 'conflict')
    loop = animate(root.value!, { x: [-2, 2], duration: 80, ease: 'inOutSine', alternate: true, loop: true })
}

onMounted(restart)
watch([kind, () => props.animated], restart)
onBeforeUnmount(() => loop?.revert())
</script>

<template>
  <span ref="root" class="token" :class="kind" :title="`${label} ${wordOf(view)}`.trim()">
    <svg ref="ring" class="ring" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14.5" /></svg>
    <span class="label mono">{{ label }}</span>
  </span>
</template>

<style scoped>
.token {
  position: relative;
  display: grid;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  font-size: 11.5px;
  font-weight: 500;
  place-items: center;
  transition:
    background 0.35s,
    color 0.35s,
    transform 0.35s;
}

.ring {
  position: absolute;
  inset: 0;
  overflow: visible;
}

.ring circle {
  fill: none;
  stroke: transparent;
  stroke-width: 2;
  stroke-linecap: round;
  transition: stroke 0.35s;
}

.label {
  position: relative;
  line-height: 1;
}

.ready {
  background: var(--ink);
  color: var(--paper);
}

.degraded {
  background: var(--degraded-fill);
  color: var(--on-degraded);
}

.unavailable {
  background: var(--bad-fill);
  color: var(--on-bad);
}

.building,
.starting,
.retrying {
  background: var(--new-soft);
  color: var(--new);
}

.building .ring circle {
  stroke: var(--new);
  stroke-dasharray: 24 68;
}

.starting .ring circle {
  stroke: var(--new);
  stroke-dasharray: 62 30;
}

.retrying .ring circle {
  stroke: var(--new);
  stroke-dasharray: 2 5;
}

.stopping {
  background: var(--control-3);
  color: var(--muted);
  transform: scale(0.84);
}

.pending,
.declared {
  color: var(--faint);
}

.pending .ring circle {
  stroke: var(--faint);
  stroke-dasharray: 3 4;
}

.declared .ring circle {
  stroke: var(--new);
  stroke-dasharray: 3 4;
}

.failed,
.conflict {
  background: var(--bad-soft);
  color: var(--bad);
  font-size: 15px;
}

.failed .ring circle,
.conflict .ring circle {
  stroke: var(--bad);
}
</style>
