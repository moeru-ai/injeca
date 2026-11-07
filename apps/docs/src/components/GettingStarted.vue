<script setup lang="ts">
import highlighted from 'virtual:highlighted-samples'

import { TabsContent, TabsIndicator, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import { computed, ref } from 'vue'

import CodeBlock from './CodeBlock.vue'
import Icon from './Icon.vue'

import { SAMPLES } from '../lab/samples'
import { theme } from '../theme'

/** How to install injeca, and a first program: the same as Getting started in the README. */
const MANAGERS = [
  { id: 'pnpm', command: 'pnpm add injeca' },
  { id: 'npm', command: 'npm install injeca' },
  { id: 'bun', command: 'bun add injeca' },
  { id: 'yarn', command: 'yarn add injeca' },
] as const

const managerId = ref<string>(MANAGERS[0].id)
const manager = computed(() => MANAGERS.find(item => item.id === managerId.value) ?? MANAGERS[0])

/** What was copied last, for a moment: the command, or the code. */
const copied = ref<'command' | 'code'>()
let reset: ReturnType<typeof setTimeout> | undefined

async function copy(what: 'command' | 'code'): Promise<void> {
  try {
    await navigator.clipboard.writeText(what === 'command' ? manager.value.command : SAMPLES['start/main']!)
  }
  catch {
    return
  }
  copied.value = what
  clearTimeout(reset)
  reset = setTimeout(() => (copied.value = undefined), 1400)
}
</script>

<template>
  <section id="getting-started" class="start" aria-labelledby="start-title">
    <h2 id="start-title" data-flash>
      {{ $t('page.start.title') }}
    </h2>

    <!--
      A terminal: the package managers on top, and the command under them, with copy on its right. The tabs come from
      reka-ui: arrow keys move between them, and one indicator slides under the active one.
    -->
    <TabsRoot v-model="managerId" class="terminal" activation-mode="automatic">
      <TabsList class="managers" :aria-label="$t('page.start.managers')">
        <TabsIndicator class="tab-indicator" />
        <TabsTrigger v-for="item in MANAGERS" :key="item.id" :value="item.id" class="manager">
          <Icon :name="`devicon:${item.id}`" />
          <span class="mono">{{ item.id }}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent v-for="item in MANAGERS" :key="item.id" :value="item.id" class="line">
        <span class="prompt mono" aria-hidden="true">$</span>
        <code class="command">{{ item.command }}</code>
        <button type="button" class="copy" :aria-label="copied === 'command' ? $t('page.start.copied') : $t('page.start.copy-command')" @click="copy('command')">
          <Icon :name="copied === 'command' ? 'check-line' : 'copy-2-line'" />
        </button>
      </TabsContent>
    </TabsRoot>
    <p class="where">
      {{ $t('page.start.where') }}
    </p>

    <div class="example">
      <div class="code">
        <button type="button" class="copy corner" :aria-label="copied === 'code' ? $t('page.start.copied') : $t('page.start.copy-code')" @click="copy('code')">
          <Icon :name="copied === 'code' ? 'check-line' : 'copy-2-line'" />
        </button>
        <CodeBlock :lines="highlighted[theme]['start/main'] ?? []" />
      </div>
      <div class="notes">
        <p>{{ $t('page.start.lead') }}</p>
        <i18n-t keypath="page.start.keys" tag="p" scope="global">
          <template #provide><code>provide</code></template>
          <template #dependsOn><code>dependsOn</code></template>
          <template #greeter><code>greeter</code></template>
          <template #config><code>config</code></template>
        </i18n-t>
        <i18n-t keypath="page.start.order" tag="p" scope="global">
          <template #start><code>start()</code></template>
          <template #config><code>config</code></template>
          <template #greeter><code>greeter</code></template>
          <template #stop><code>stop()</code></template>
        </i18n-t>
        <div class="next">
          <a class="pill ink" href="#unit">{{ $t('page.start.read') }}</a>
          <a class="pill" href="#sandbox">{{ $t('page.hero.play') }}</a>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.start {
  padding-top: 96px;
  scroll-margin-top: 24px;
}

h2 {
  margin: 0;
  font-size: 40px;
}

.terminal {
  width: min(100%, 560px);
  margin-top: 28px;
  overflow: hidden;
  border-radius: 18px;
  background: var(--surface);
}

.managers {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 8px 8px 0;
}

/* One fill that slides to the active tab, so a quick switch moves it instead of fading two fills. */
.tab-indicator {
  position: absolute;
  top: 8px;
  left: 0;
  width: var(--reka-tabs-indicator-size);
  height: calc(100% - 8px);
  border-radius: 10px;
  background: var(--control);
  transform: translateX(var(--reka-tabs-indicator-position));
  transition:
    transform 0.25s cubic-bezier(0.2, 0, 0, 1),
    width 0.25s cubic-bezier(0.2, 0, 0, 1);
}

.manager {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  outline: none;
}

.manager:hover,
.manager[data-state='active'] {
  color: var(--ink);
}

.manager:focus-visible {
  box-shadow: 0 0 0 2px var(--new);
}

/* The icon keeps its colors, a little faded when its tab is not active. Only opacity changes: no filter to repaint. */
.manager .icon {
  font-size: 16px;
  opacity: 0.55;
}

.manager:hover .icon,
.manager[data-state='active'] .icon {
  opacity: 1;
}

.line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 8px;
  padding: 10px 8px 10px 16px;
  border-radius: 12px;
  background: var(--control);
}

/* reka-ui keeps the other panels in the page, hidden. */
.line[hidden] {
  display: none;
}

.prompt {
  color: var(--faint);
  font-size: 15px;
  user-select: none;
}

.command {
  min-width: 0;
  flex: 1;
  overflow-x: auto;
  font-size: 15px;
  white-space: nowrap;
}

.copy {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
  place-items: center;
  transition:
    background 0.2s,
    color 0.2s;
}

.copy:hover {
  background: var(--control-2);
  color: var(--ink);
}

.where {
  margin: 12px 0 0;
  color: var(--muted);
  font-size: 14.5px;
}

.example {
  display: grid;
  gap: 12px;
  margin-top: 24px;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
}

.code {
  position: relative;
  min-width: 0;
  padding: 22px 24px;
  border-radius: 22px;
  background: var(--surface);
}

.copy.corner {
  position: absolute;
  top: 12px;
  right: 12px;
}

.notes {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 22px;
  color: var(--ink-2);
  font-size: 15.5px;
  line-height: 1.55;
}

.notes p {
  margin: 0;
}

.notes p:first-child {
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 21px;
}

.next {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
}

@media (max-width: 1100px) {
  .example {
    grid-template-columns: minmax(0, 1fr);
  }

  .notes {
    padding: 4px 4px 0;
  }
}

@media (max-width: 640px) {
  h2 {
    font-size: 34px;
  }

  .code {
    padding: 18px 16px;
  }

  .copy.corner {
    top: 8px;
    right: 8px;
  }
}
</style>
