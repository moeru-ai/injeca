<script setup lang="ts">
import Icon from './Icon.vue'

import { FEATURES } from '../features'

/**
 * The README figure of what injeca handles: the seven pillars of the page, as cards. The first and the sixth take two
 * columns, as on the page, so the grid fills three rows of three.
 */
const HUES = [0, 1, 5, 9, 8]
</script>

<template>
  <div class="features" role="img" :aria-label="`What injeca handles: ${FEATURES.map(f => `${f.title}, with ${f.primitives.join(', ')}.`).join(' ')}`">
    <ul class="grid">
      <li v-for="(feature, i) in FEATURES" :key="feature.title" class="card" :class="[`hue-${HUES[i % HUES.length]}`, { wide: feature.wide }]">
        <span class="head">
          <span class="badge"><Icon :name="feature.icon" /></span>
          <span class="title">{{ feature.title }}</span>
        </span>
        <span class="text">{{ feature.text }}</span>
        <span class="primitives">
          <code v-for="primitive in feature.primitives" :key="primitive">{{ primitive }}</code>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.features {
  width: 1440px;
  height: 700px;
  padding: 40px 48px;
  border-radius: 32px;
  background: var(--paper);
}

.grid {
  display: grid;
  height: 100%;
  gap: 14px;
  margin: 0;
  padding: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(0, 1fr));
  list-style: none;
}

.wide {
  grid-column: span 2;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 22px;
  border-radius: 22px;
  background: var(--surface);
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.badge {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 11px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 20px;
  place-items: center;
}

.title {
  font-family: var(--font-display);
  font-size: 21px;
}

.text {
  flex: 1;
  color: var(--ink-2);
  font-size: 15px;
  line-height: 1.5;
}

.primitives {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.primitives code {
  padding: 3px 9px;
  border-radius: 8px;
  background: var(--control);
  color: var(--accent);
  font-size: 12.5px;
}
</style>
