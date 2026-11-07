<script setup lang="ts">
import Icon from './Icon.vue'

import { useI18n } from 'vue-i18n'

import { FEATURES } from '../features'
import { text } from '../i18n'
import { SCENARIOS } from '../lab/scenarios'

/** The seven pillars of injeca, before the chapters. Each card goes to the chapter that shows it. */
const HUES = [0, 1, 5, 9, 8]

const { t } = useI18n()

function where(target: string): string {
  const index = SCENARIOS.findIndex(s => s.id === target)
  if (index < 0)
    return t('page.features.cheat-sheet')
  const scenario = SCENARIOS[index]!
  return t('page.features.chapter', { n: index + 1, name: text(`chapters.${scenario.id}.nav`, scenario.nav) })
}
</script>

<template>
  <section id="features" class="features" aria-labelledby="features-title">
    <h2 id="features-title" data-flash>
      {{ $t('page.features.title') }}
    </h2>
    <ul class="grid">
      <li v-for="(feature, i) in FEATURES" :key="feature.title" :class="[`hue-${HUES[i % HUES.length]}`, { wide: feature.wide }]">
        <a class="card" :href="`#${feature.target}`">
          <span class="head">
            <span class="badge"><Icon :name="feature.icon" /></span>
            <span class="title">{{ text(`features.${i}.title`, feature.title) }}</span>
          </span>
          <span class="text">{{ text(`features.${i}.text`, feature.text) }}</span>
          <span class="primitives">
            <code v-for="primitive in feature.primitives" :key="primitive">{{ primitive }}</code>
          </span>
          <span class="where">{{ where(feature.target) }} →</span>
        </a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.features {
  padding-top: 96px;
  scroll-margin-top: 24px;
}

h2 {
  margin: 0;
  font-size: 40px;
}

.grid {
  display: grid;
  gap: 12px;
  margin: 28px 0 0;
  padding: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  list-style: none;
}

.wide {
  grid-column: span 2;
}

.card {
  display: flex;
  height: 100%;
  flex-direction: column;
  gap: 12px;
  padding: 22px;
  border-radius: 22px;
  background: var(--surface);
  color: inherit;
  text-decoration: none;
  transition:
    background 0.2s,
    transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.card:hover {
  box-shadow: var(--shadow-card);
  transform: translateY(-2px);
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.badge {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 22px;
  place-items: center;
}

.title {
  font-family: var(--font-display);
  font-size: 21px;
}

.text {
  flex: 1;
  max-width: 620px;
  color: var(--ink-2);
  font-size: 15.5px;
  line-height: 1.55;
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

.where {
  color: var(--muted);
  font-size: 13.5px;
}

.card:hover .where {
  color: var(--ink);
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .wide {
    grid-column: auto;
  }
}
</style>
