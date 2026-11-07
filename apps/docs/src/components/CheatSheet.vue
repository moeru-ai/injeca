<script setup lang="ts">
import highlighted from 'virtual:highlighted-samples'

import { reactive } from 'vue'

import CodeBlock from './CodeBlock.vue'
import Icon from './Icon.vue'
import TransitionVertical from './TransitionVertical.vue'

import { CHEAT } from '../cheat'
import { text } from '../i18n'
import { SCENARIOS } from '../lab/scenarios'
import { theme } from '../theme'

/** Every primitive in one sentence. A card opens in place to show a few lines of code, and the chapter that runs it. */
const open = reactive(new Set<string>())
/** The chapter hues of the groups. They skip the hues of the states (green, red, and violet) and the orange that reads as red, so a color never reads as a result. */
const GROUP_HUES = [0, 1, 5, 9, 8]
function chapterOf(id: string) {
  const index = SCENARIOS.findIndex(s => s.id === id)
  return { number: index + 1, nav: text(`chapters.${id}.nav`, SCENARIOS[index]!.nav) }
}

function toggle(id: string): void {
  if (open.has(id))
    open.delete(id)
  else
    open.add(id)
}
</script>

<template>
  <section id="cheat-sheet" class="cheat" aria-labelledby="cheat-title">
    <h2 id="cheat-title" data-flash>
      {{ $t('page.cheat.title') }}
    </h2>
    <div class="groups">
      <div v-for="(group, g) in CHEAT" :key="group.title" class="group" :class="`hue-${GROUP_HUES[g % GROUP_HUES.length]}`">
        <h3>{{ text(`cheat.groups.${g}`, group.title) }}</h3>
        <ul class="cards">
          <li v-for="card in group.cards" :key="card.id" class="card" :class="{ open: open.has(card.id) }">
            <button type="button" class="face" :aria-expanded="open.has(card.id)" @click="toggle(card.id)">
              <code class="use">{{ card.use }}</code>
              <span class="text">{{ text(`cheat.cards.${card.id}`, card.text) }}</span>
              <Icon name="down-line" class="mark" />
            </button>
            <TransitionVertical>
              <div v-if="open.has(card.id)" class="body">
                <CodeBlock :lines="highlighted[theme][`cheat/${card.id}`] ?? []" />
                <a v-if="card.chapter" class="run" :href="`#${card.chapter}`">
                  <Icon name="play-fill" />
                  <strong>{{ $t('page.cheat.chapter', { n: chapterOf(card.chapter).number }) }}</strong>
                  <span>{{ chapterOf(card.chapter).nav }}</span>
                </a>
              </div>
            </TransitionVertical>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cheat {
  padding-top: 140px;
  scroll-margin-top: 24px;
}

h2 {
  margin: 0;
  font-size: 40px;
  font-weight: 400;
}

.groups {
  display: grid;
  gap: 36px 28px;
  margin-top: 32px;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
}

h3 {
  margin: 0 0 12px;
  color: var(--accent);
  font-size: 16px;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.card {
  border-radius: 16px;
  background: var(--surface);
  transition: background 0.2s;
}

.card:hover,
.card.open {
  box-shadow: var(--shadow-card);
}

.face {
  display: grid;
  width: 100%;
  align-items: start;
  gap: 4px 12px;
  padding: 12px 16px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  grid-template-columns: minmax(0, 1fr) auto;
  text-align: left;
}

.use {
  color: var(--accent);
  font-size: 13.5px;
}

.text {
  grid-column: 1;
  color: var(--ink-2);
  font-size: 14.5px;
  line-height: 1.45;
}

.mark {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  color: var(--muted);
  font-size: 18px;
  transition: transform 0.28s cubic-bezier(0.2, 0, 0, 1);
}

.open .mark {
  transform: rotate(180deg);
}

.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 16px 14px;
}

.body :deep(pre) {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--control);
  font-size: 12.5px;
}

/* A solid badge, so it reads on any card. */
.run {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 7px;
  padding: 6px 13px 6px 10px;
  border-radius: 999px;
  background: var(--accent-fill);
  color: var(--on-accent);
  font-size: 13.5px;
  text-decoration: none;
  transition: transform 0.15s;
}

.run:hover {
  transform: translateX(2px);
}

.run strong {
  font-weight: 400;
}

.run span {
  opacity: 0.8;
}
</style>
