<script setup lang="ts">
import { computed } from 'vue'

import CompareFigure from './CompareFigure.vue'
import Hero from './Hero.vue'

import { SCENARIOS } from '../lab/scenarios'

/** One README banner at its capture size: `hero`, or `compare-<scenario>`. */
const props = defineProps<{ scene: string }>()

const scenario = computed(() => SCENARIOS.find(s => `compare-${s.id}` === props.scene))
</script>

<template>
  <Hero v-if="scene === 'hero'" capture />
  <CompareFigure v-else-if="scenario" :scenario="scenario" :number="SCENARIOS.indexOf(scenario) + 1" />
</template>
