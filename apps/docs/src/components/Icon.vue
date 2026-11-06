<script setup lang="ts">
import icons from 'virtual:icons'

/** An icon from the build: MingCute, or Devicon as `devicon:<name>`. It takes the size of 1em, and a MingCute icon takes the color of the text. */
defineProps<{ name: string }>()
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- the body comes from the icon set at build time -->
  <svg class="icon" :viewBox="`0 0 ${icons[name]?.size ?? 24} ${icons[name]?.size ?? 24}`" aria-hidden="true" v-html="icons[name]?.body" />
</template>

<style scoped>
.icon {
  width: 1em;
  height: 1em;
  flex: none;
}
</style>
