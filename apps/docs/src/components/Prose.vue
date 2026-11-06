<script setup lang="ts">
import { h } from 'vue'

/** A sentence where `text in backticks` shows as code. A render function keeps the template from adding spaces. */
const props = defineProps<{ text: string }>()

const render = () => props.text.split('`').map((part, i) => i % 2 === 1 ? h('code', { class: 'inline' }, part) : part)
</script>

<template>
  <render />
</template>

<style scoped>
.inline {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--control);
  font-size: 0.86em;
}
</style>
