<script setup lang="ts">
/** Code that vite.config.ts highlighted at build time: lines of tokens. */
defineProps<{ lines: readonly (readonly { color?: string, content: string, fontStyle?: number }[])[] }>()

function tokenStyle(token: { color?: string, fontStyle?: number }): Record<string, string> {
  const style: Record<string, string> = {}
  if (token.color)
    style.color = token.color
  if ((token.fontStyle ?? 0) & 1)
    style.fontStyle = 'italic'
  if ((token.fontStyle ?? 0) & 2)
    style.fontWeight = '600'
  return style
}
</script>

<template>
  <pre class="mono"><code><span v-for="(line, i) in lines" :key="i" class="line"><span v-for="(token, j) in line" :key="j" :style="tokenStyle(token)">{{ token.content }}</span><br v-if="line.length === 0"></span></code></pre>
</template>

<style scoped>
pre {
  overflow-x: auto;
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}

.line {
  display: block;
  white-space: pre-wrap;
}

/* A phone: long lines scroll sideways instead of wrapping, so the code keeps its shape. */
@media (max-width: 640px) {
  pre {
    font-size: 12px;
  }

  .line {
    white-space: pre;
  }
}
</style>
