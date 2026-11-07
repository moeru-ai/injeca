<script setup lang="ts">
import HeroScene from '../hero/HeroScene.vue'
import Icon from './Icon.vue'

import { TIMES } from '../hero/scene'
import { toggleLocale } from '../i18n'
import { theme, toggleTheme } from '../theme'

/** The hero: what injeca is, beside a scene where a target comes apart into what it needs, and is built back. */
const props = defineProps<{ capture?: boolean, og?: boolean }>()

const repo = 'https://github.com/moeru-ai/injeca'
// `&at=<ms>` picks the moment of a capture. By default the second batch is in flight: the units come together into app.
const at = Number(new URLSearchParams(location.search).get('at') ?? TIMES.built + 1950)
</script>

<template>
  <header id="top" class="hero" :class="{ capture: props.capture, og: props.og }">
    <div class="scene">
      <HeroScene :at="props.capture ? at : undefined" :left="0.36" />
    </div>
    <div v-if="!props.capture" class="corner">
      <button type="button" class="round lang" :aria-label="$t('page.hero.to-language')" :title="$t('page.hero.to-language')" @click="toggleLocale">
        <Icon name="translate-2-line" />
        <span>{{ $t('page.hero.language') }}</span>
      </button>
      <a class="round" :href="repo" :aria-label="$t('page.hero.github')" title="GitHub"><Icon name="github-line" /></a>
      <button type="button" class="round" :aria-label="theme === 'dark' ? $t('page.hero.to-light') : $t('page.hero.to-dark')" :title="theme === 'dark' ? $t('page.nav.light') : $t('page.nav.dark')" @click="toggleTheme">
        <Icon :name="theme === 'dark' ? 'sun-line' : 'moon-line'" />
      </button>
    </div>
    <!-- The text floats over the canvas. Only its links take the pointer, so the pieces stay easy to point at. -->
    <div class="text">
      <h1>injeca</h1>
      <p class="what">
        {{ $t('page.hero.what') }}
      </p>
      <p class="tagline">
        {{ $t('page.hero.tagline') }}
      </p>
      <p class="sub">
        {{ $t('page.hero.sub') }}
      </p>
      <div v-if="!props.capture" class="actions">
        <a class="pill ink" href="#getting-started">{{ $t('page.hero.get-started') }}</a>
        <a class="pill" href="#sandbox">{{ $t('page.hero.play') }}</a>
      </div>
    </div>
  </header>
</template>

<style scoped>
.hero {
  position: relative;
  overflow: hidden;
  height: clamp(640px, 84vh, 820px);
}

.hero.capture {
  width: 1440px;
  height: 600px;
  border-radius: 32px;
  background: var(--paper);
}

/* On a wide screen, the scene stays beside the text instead of going to the far edge. */
.scene {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: min(100%, 1680px);
  transform: translateX(-50%);
}

/* GitHub and the theme, as icons in the top right. */
.corner {
  position: absolute;
  z-index: 2;
  top: 24px;
  right: 40px;
  display: flex;
  gap: 6px;
}

.round {
  display: grid;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--control);
  color: var(--ink);
  font-size: 20px;
  cursor: pointer;
  place-items: center;
  transition: background 0.2s;
}

.round:hover {
  background: var(--control-2);
}

/* The language: its icon, and the name of the other language. */
.round.lang {
  display: inline-flex;
  width: auto;
  gap: 6px;
  padding: 0 14px 0 12px;
  border-radius: 999px;
  font-size: 18px;
}

.lang span {
  font-size: 14px;
}

.text {
  position: relative;
  z-index: 1;
  display: flex;
  max-width: 1440px;
  height: 100%;
  flex-direction: column;
  justify-content: center;
  margin: 0 auto;
  padding: 0 40px 80px;
  pointer-events: none;
}

.hero.og {
  width: 1200px;
  height: 630px;
}

/* The Open Graph image: the name and the tagline over the scene, larger, as a link preview shows it small. */
.og .text {
  padding: 0 56px;
}

.og h1 {
  font-size: 120px;
}

.og .tagline {
  font-size: 36px;
}

.og .sub {
  display: none;
}

.capture .text {
  padding: 0 64px;
}

.text > * {
  max-width: 500px;
}

h1 {
  margin: 0;
  font-size: 104px;
  font-weight: 400;
  letter-spacing: -0.02em;
  line-height: 0.95;
}

.tagline {
  margin: 20px 0 0;
  font-family: var(--font-display);
  font-size: 28px;
  line-height: 1.25;
  text-wrap: balance;
}

.sub {
  margin: 16px 0 0;
  color: var(--ink-2);
  font-size: 17px;
  line-height: 1.55;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 32px;
  pointer-events: auto;
}

/* The words can be selected. Only the empty space around them lets the pointer through to the scene. */
h1,
.what,
.tagline,
.sub {
  width: fit-content;
  pointer-events: auto;
}

/* What the name means, on a narrow screen, where the tagline gives the scene its room. */
.what {
  display: none;
}

/*
 * A narrow screen: the scene fills the first screen. The name sits small in the top left, the steps of the scene
 * read under it, and the links keep to the corner at the bottom left, beside the map.
 */
@media (max-width: 960px) {
  .hero {
    height: 100svh;
    min-height: 600px;
    max-height: 1100px;
  }

  .corner {
    top: calc(14px + env(safe-area-inset-top));
    right: 16px;
  }

  .text {
    justify-content: flex-start;
    padding: calc(16px + env(safe-area-inset-top)) 20px 0;
  }

  h1 {
    font-size: 32px;
    letter-spacing: 0;
    line-height: 1.2;
  }

  .what {
    display: block;
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 14.5px;
  }

  .tagline,
  .sub {
    display: none;
  }

  .actions {
    position: absolute;
    bottom: calc(16px + env(safe-area-inset-bottom));
    left: 20px;
    flex-direction: column;
    align-items: flex-start;
    margin: 0;
  }
}
</style>
