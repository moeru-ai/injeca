<script setup lang="ts">
import { computed } from 'vue'

import CompareFigure from './CompareFigure.vue'
import FeaturesFigure from './FeaturesFigure.vue'
import Hero from './Hero.vue'
import PhasesFigure from './PhasesFigure.vue'

import { SCENARIOS } from '../lab/scenarios'

/** One README banner at its capture size: `hero`, `og`, `features`, `phases`, or `compare-<scenario>`. */
const props = defineProps<{ scene: string }>()

const scenario = computed(() => SCENARIOS.find(s => `compare-${s.id}` === props.scene))
</script>

<template>
  <Hero v-if="scene === 'hero'" capture />
  <Hero v-else-if="scene === 'og'" capture og />
  <FeaturesFigure v-else-if="scene === 'features'" />
  <PhasesFigure v-else-if="scene === 'phases'" />
  <CompareFigure v-else-if="scenario" :scenario="scenario" :number="SCENARIOS.indexOf(scenario) + 1" />
</template>
