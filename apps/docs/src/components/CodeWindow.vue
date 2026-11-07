<script setup lang="ts">
/**
 * A file of code, highlighted at build time with @pierre/highlights. The lines that the current step runs light up,
 * and the others step back.
 */
const props = defineProps<{
  file: string
  lines: readonly (readonly { color?: string, content: string, fontStyle?: number }[])[]
  /** 1-based line numbers. */
  active?: readonly number[]
}>()

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

const state = (line: number) => !props.active?.length ? undefined : props.active.includes(line) ? 'on' : 'off'
</script>

<template>
  <figure class="window">
    <figcaption class="bar">
      <span class="file mono">{{ file }}</span>
      <span class="lang mono">TypeScript</span>
    </figcaption>
    <pre class="mono"><code><span v-for="(line, i) in lines" :key="i" class="line" :class="state(i + 1)"><span class="ln">{{ i + 1 }}</span><span class="src"><span v-for="(token, j) in line" :key="j" :style="tokenStyle(token)">{{ token.content }}</span><br v-if="line.length === 0"></span></span></code></pre>
  </figure>
</template>

<style scoped>
.window {
  overflow: hidden;
  margin: 0;
  border-radius: 20px;
  background: var(--surface);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: var(--control);
}

.file {
  color: var(--ink);
  font-size: 13px;
}

.lang {
  color: var(--muted);
  font-size: 11.5px;
}

pre {
  overflow-x: auto;
  margin: 0;
  padding: 12px 0;
  font-size: 13px;
  line-height: 1.75;
}

.line {
  display: grid;
  padding-right: 18px;
  grid-template-columns: 42px minmax(0, 1fr);
  transition:
    background 0.3s,
    opacity 0.3s;
}

.ln {
  padding-right: 14px;
  color: var(--faint);
  text-align: right;
  user-select: none;
}

.src {
  white-space: pre-wrap;
}

.line.on {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
  box-shadow: inset 2px 0 0 var(--accent, var(--new));
}

.line.on .ln {
  color: var(--accent, var(--new));
}

.line.off {
  opacity: 0.72;
}

/* A phone: long lines scroll sideways instead of wrapping, so the code keeps its shape. */
@media (max-width: 640px) {
  pre {
    font-size: 12px;
  }

  code {
    display: block;
    width: max-content;
    min-width: 100%;
  }

  .src {
    white-space: pre;
  }
}
</style>
