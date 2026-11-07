<script setup lang="ts">
import type { Scenario } from '../lab/scenarios'

import Coverage from './Coverage.vue'

import { framesOf } from '../lab/store'

/**
 * The README figure of one chapter, at about 3:1: the question on the left, and on the right one row for each
 * primitive, with a bar for each unit that shows whether it could serve at each step.
 */
const props = defineProps<{ scenario: Scenario, number: number }>()

const nodes = props.scenario.nodes.map(node => node.id)
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
      <p class="legend">
        <span><i class="key serving" />serves</span>
        <span><i class="key degraded" />degraded</span>
        <span><i class="key unavailable" />unavailable</span>
        <span><i class="key down" />cannot serve</span>
      </p>
    </div>
    <div class="rows">
      <section v-for="variant in scenario.variants" :key="variant.id" class="row">
        <p class="head">
          <code>{{ variant.primitive }}</code>
          <span class="outcome" :class="variant.tone">{{ variant.outcome }}</span>
        </p>
        <Coverage :nodes="nodes" :frames="framesOf(scenario, variant)" />
      </section>
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
  gap: 56px;
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
  font-size: 32px;
  line-height: 1.15;
}

.question {
  margin: 14px 0 0;
  color: var(--ink-2);
  font-size: 18px;
  line-height: 1.45;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 24px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.key {
  display: inline-block;
  width: 18px;
  height: 8px;
  border-radius: 3px;
}

.key.serving {
  background: var(--ink);
}

.key.degraded {
  background: var(--degraded-fill);
}

.key.unavailable {
  background: var(--bad-fill);
}

.key.down {
  background: repeating-linear-gradient(90deg, var(--control-3) 0 3px, transparent 3px 6px) 0 50% / 100% 2px repeat-x;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 24px 28px;
  border-radius: 24px;
  background: var(--surface);
}

.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  margin: 0 0 8px;
}

.head code {
  font-size: 14.5px;
}

.outcome {
  font-size: 14.5px;
}

.outcome.good {
  color: var(--good);
}

.outcome.warn {
  color: var(--muted);
}

.outcome.bad {
  color: var(--bad);
}
</style>
