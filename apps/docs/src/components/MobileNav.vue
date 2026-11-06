<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import Icon from './Icon.vue'
import TransitionVertical from './TransitionVertical.vue'

import { toggleLocale } from '../i18n'
import { activeSection, labelOf, SECTIONS, watchSections } from '../sections'
import { theme, toggleTheme } from '../theme'

/**
 * The bar of a narrow screen, where the sidebar has no room. It comes in once the hero is gone, names the section on
 * screen, and opens a menu of every section. A thin line under it fills as the page goes by.
 */
const repo = 'https://github.com/moeru-ai/injeca'

const shown = ref(false)
const open = ref(false)
const list = ref<HTMLElement>()
const progress = ref<HTMLElement>()
const current = computed(() => SECTIONS.find(section => section.id === activeSection.value) ?? SECTIONS[0]!)

let stop: (() => void) | undefined
let hero: IntersectionObserver | undefined
let frame = 0

/** Writes the progress by its style, once a frame at most, so a scroll costs no reactive update. */
function onScroll(): void {
  if (frame)
    return
  frame = requestAnimationFrame(() => {
    frame = 0
    const max = document.documentElement.scrollHeight - innerHeight
    if (progress.value)
      progress.value.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`
  })
}

onMounted(() => {
  stop = watchSections()
  const header = document.querySelector('.hero')
  if (header) {
    hero = new IntersectionObserver(([entry]) => {
      shown.value = !entry?.isIntersecting
      if (!shown.value)
        open.value = false
    }, { rootMargin: '-56px 0px 0px 0px' })
    hero.observe(header)
  }
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()
})

onBeforeUnmount(() => {
  stop?.()
  hero?.disconnect()
  removeEventListener('scroll', onScroll)
  cancelAnimationFrame(frame)
  document.documentElement.classList.remove('menu-open')
})

// While the menu is open, the page under it holds still, and the list shows the section on screen.
watch(open, async (value) => {
  document.documentElement.classList.toggle('menu-open', value)
  if (!value)
    return
  await nextTick()
  const element = list.value?.querySelector<HTMLElement>('.on')
  if (list.value && element)
    list.value.scrollTop = element.offsetTop - list.value.clientHeight / 2 + element.clientHeight / 2
})

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape')
    open.value = false
}
</script>

<template>
  <div class="mobile-nav" :class="{ shown: shown || open, open }" @keydown="onKey">
    <Transition name="fade">
      <div v-if="open" class="backdrop" aria-hidden="true" @click="open = false" />
    </Transition>

    <nav class="bar" :aria-label="$t('page.nav.sections')">
      <a class="mark" href="#top" @click="open = false">injeca</a>
      <button type="button" class="where" :aria-expanded="open" aria-controls="mobile-menu" @click="open = !open">
        <Transition name="swap" mode="out-in">
          <span :key="current.id" class="where-text">
            <span v-if="current.n" class="n mono">{{ current.n }}</span>
            <span class="label">{{ labelOf(current) }}</span>
          </span>
        </Transition>
      </button>
      <button type="button" class="toggle" :aria-label="open ? $t('page.nav.close') : $t('page.nav.open')" :aria-expanded="open" aria-controls="mobile-menu" @click="open = !open">
        <Icon :name="open ? 'close-line' : 'menu-line'" />
      </button>
      <span class="progress" aria-hidden="true"><span ref="progress" class="progress-fill" /></span>
    </nav>

    <TransitionVertical :duration="320">
      <div v-if="open" id="mobile-menu" class="menu">
        <div ref="list" class="list">
          <a
            v-for="section in SECTIONS"
            :key="section.id"
            :href="`#${section.id}`"
            class="entry"
            :class="{ on: section.id === activeSection }"
            :aria-current="section.id === activeSection ? 'location' : undefined"
            @click="open = false"
          >
            <span class="n mono">{{ section.n }}</span>
            <span class="label">{{ labelOf(section) }}</span>
          </a>
        </div>
        <div class="foot">
          <button type="button" class="pill" @click="toggleTheme">
            <Icon :name="theme === 'dark' ? 'sun-line' : 'moon-line'" />
            {{ theme === 'dark' ? $t('page.nav.light') : $t('page.nav.dark') }}
          </button>
          <button type="button" class="pill" :aria-label="$t('page.hero.to-language')" @click="toggleLocale">
            <Icon name="translate-2-line" />
            {{ $t('page.hero.language') }}
          </button>
          <a class="pill" :href="repo">
            <Icon name="github-line" />
            {{ $t('page.nav.github') }}
          </a>
        </div>
      </div>
    </TransitionVertical>
  </div>
</template>

<style scoped>
.mobile-nav {
  display: none;
}

@media (max-width: 1000px) {
  .mobile-nav {
    position: fixed;
    z-index: 20;
    top: 0;
    right: 0;
    left: 0;
    display: block;
    transform: translateY(-110%);
    transition: transform 0.35s cubic-bezier(0.2, 0, 0, 1);
    pointer-events: none;
  }

  .mobile-nav.shown {
    transform: none;
    pointer-events: auto;
  }
}

.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 28%);
}

.bar {
  position: relative;
  display: flex;
  height: 56px;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 20px;
  background: color-mix(in srgb, var(--paper) 86%, transparent);
  backdrop-filter: blur(14px) saturate(1.4);
  -webkit-backdrop-filter: blur(14px) saturate(1.4);
  transition: background 0.2s;
}

.open .bar {
  background: var(--surface);
}

.mark {
  flex: none;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 21px;
  text-decoration: none;
}

/* The section on screen. A tap on it opens the menu too. */
.where {
  display: flex;
  min-width: 0;
  flex: 1;
  justify-content: center;
  padding: 8px 4px;
  border: 0;
  background: transparent;
  color: var(--ink-2);
  font: inherit;
  font-size: 14.5px;
  cursor: pointer;
}

.where-text {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.where .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.where .n {
  color: var(--new);
  font-size: 11.5px;
}

.toggle {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--ink);
  font-size: 22px;
  cursor: pointer;
  place-items: center;
}

.toggle:hover,
.open .toggle {
  background: var(--control);
}

.progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  background: var(--line);
}

.progress-fill {
  display: block;
  height: 100%;
  background: var(--new);
  transform: scaleX(0);
  transform-origin: 0 50%;
}

.menu {
  position: relative;
  overflow: hidden;
  border-radius: 0 0 24px 24px;
  background: var(--surface);
  box-shadow: 0 24px 48px var(--shadow-strong);
}

.list {
  display: flex;
  max-height: calc(100svh - 56px - 96px);
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 10px 12px;
}

.entry {
  display: grid;
  gap: 10px;
  padding: 11px 12px;
  border-radius: 12px;
  color: var(--muted);
  grid-template-columns: 24px minmax(0, 1fr);
  text-decoration: none;
}

.entry.on {
  background: var(--control);
  color: var(--ink);
}

.entry .n {
  color: var(--faint);
  font-size: 11.5px;
  line-height: 22px;
}

.entry.on .n {
  color: var(--new);
}

.entry .label {
  font-size: 16px;
  line-height: 22px;
}

.foot {
  display: flex;
  gap: 8px;
  padding: 10px 20px 18px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.swap-enter-active,
.swap-leave-active {
  transition:
    opacity 0.18s,
    transform 0.18s;
}

.swap-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.swap-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
