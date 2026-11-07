<script setup lang="ts">
import type { Frame } from '../lab/lab'

/**
 * Whether each unit can serve, step by step. A bar that goes on means the unit never stopped serving.
 * A hole in it is a time when the unit had no instance that could take a call.
 */
const props = defineProps<{
  nodes: readonly string[]
  frames: readonly Frame[]
  /** The current step. The steps after it are faint. Without it, every step shows. */
  step?: number
}>()

type Cell = 'serving' | 'degraded' | 'unavailable' | 'down'

function cellOf(frame: Frame, node: string): Cell {
  const running = frame.nodes[node]?.find(view => view.phase === 'running')
  if (!running)
    return 'down'
  return running.status === 'unavailable' ? 'unavailable' : running.status === 'degraded' ? 'degraded' : 'serving'
}

const keyOf = (id: string) => id.slice(id.indexOf('/') + 1)
const future = (index: number) => props.step !== undefined && index > props.step
</script>

<template>
  <div class="coverage" :style="{ '--steps': frames.length }" role="table" :aria-label="$t('chapter.coverage')">
    <div v-for="node in nodes" :key="node" class="row" role="row">
      <span class="name mono" role="rowheader">{{ keyOf(node) }}</span>
      <span class="cells">
        <span
          v-for="(frame, i) in frames"
          :key="i"
          class="cell"
          role="cell"
          :class="[cellOf(frame, node), { future: future(i), now: i === step }]"
          :aria-label="`Step ${i + 1}: ${cellOf(frame, node)}`"
        />
      </span>
    </div>
  </div>
</template>

<style scoped>
.coverage {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: grid;
  align-items: center;
  gap: 12px;
  grid-template-columns: 84px minmax(0, 1fr);
}

.name {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cells {
  display: grid;
  gap: 3px;
  grid-template-columns: repeat(var(--steps), minmax(0, 1fr));
}

.cell {
  height: 10px;
  border-radius: 3px;
  background: var(--control-2);
  transition:
    background 0.35s,
    opacity 0.35s;
}

.cell.serving {
  background: var(--ink);
}

.cell.degraded {
  background: var(--degraded-fill);
}

.cell.unavailable {
  background: var(--bad-fill);
}

/* A step where the unit cannot serve is a hole: a faint dotted line. */
.cell.down {
  background: repeating-linear-gradient(90deg, var(--control-3) 0 3px, transparent 3px 7px);
  background-position: 0 50%;
  background-repeat: repeat-x;
  background-size: 100% 2px;
}

.cell.future {
  opacity: 0.22;
}
</style>
