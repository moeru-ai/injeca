<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

import { activeSection as active, labelOf, SECTIONS, watchSections } from '../sections'

/** The chapters, beside the page. The chapter on screen has a fill, and a click moves to a chapter in place. */
let stop: (() => void) | undefined
onMounted(() => (stop = watchSections()))
onBeforeUnmount(() => stop?.())
</script>

<template>
  <nav class="nav hue-0" :aria-label="$t('page.nav.sections')">
    <a v-for="entry in SECTIONS" :key="entry.id" :href="`#${entry.id}`" class="entry" :class="{ on: active === entry.id }" :aria-current="active === entry.id ? 'location' : undefined">
      <span class="n mono">{{ entry.n }}</span>
      <span class="label">{{ labelOf(entry) }}</span>
    </a>
  </nav>
</template>

<style scoped>
.nav {
  position: sticky;
  top: 32px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.entry {
  display: grid;
  gap: 2px 10px;
  padding: 8px 12px;
  border-radius: 12px;
  color: var(--muted);
  grid-template-columns: 22px minmax(0, 1fr);
  text-decoration: none;
  transition:
    background 0.2s,
    color 0.2s;
}

.entry:hover {
  color: var(--ink);
}

.entry.on {
  background: var(--control);
  color: var(--ink);
}

.n {
  color: var(--faint);
  font-size: 11px;
  line-height: 22px;
}

.on .n {
  color: var(--accent);
}

.label {
  font-size: 15px;
  line-height: 22px;
}
</style>
