<script setup lang="ts">
import CaptureFrame from './components/CaptureFrame.vue'
import Chapter from './components/Chapter.vue'
import ChapterNav from './components/ChapterNav.vue'
import CheatSheet from './components/CheatSheet.vue'
import Features from './components/Features.vue'
import GettingStarted from './components/GettingStarted.vue'
import Hero from './components/Hero.vue'
import Icon from './components/Icon.vue'
import MobileNav from './components/MobileNav.vue'
import Sandbox from './components/Sandbox.vue'

import { SCENARIOS } from './lab/scenarios'
import { ready } from './lab/store'

/**
 * `?capture=<scene>` renders one README banner at its size in capture.ts.
 * `&theme=dark` picks the dark theme.
 */
const params = new URLSearchParams(location.search)
const scene = params.get('capture')

// A banner has rounded corners on a transparent page, so it sits well on any README background.
if (scene !== null)
  document.documentElement.classList.add('capture')

// scripts/banners.ts waits for this flag: the lab ran every variant, and the fonts are in.
void ready.then(() => document.fonts.ready).then(() => {
  ;(window as { __labReady?: boolean }).__labReady = true
})

const repo = 'https://github.com/moeru-ai/injeca'
</script>

<template>
  <CaptureFrame v-if="scene !== null" :scene="scene" />
  <template v-else>
    <MobileNav />
    <Hero />
    <div class="book">
      <aside class="side">
        <ChapterNav />
      </aside>
      <main class="chapters">
        <GettingStarted />
        <Features />
        <Sandbox />
        <Chapter v-for="(scenario, i) in SCENARIOS" :key="scenario.id" :scenario="scenario" :index="i" />
        <CheatSheet />
      </main>
    </div>
    <footer class="footer">
      <span class="mark">injeca</span>
      <i18n-t keypath="page.footer.made" tag="p" class="credit" scope="global">
        <template #heart>
          <Icon name="heart-fill" class="heart" />
        </template>
        <template #who>
          <a href="https://github.com/moeru-ai">Moeru AI</a>
        </template>
      </i18n-t>
      <i18n-t keypath="page.footer.license" tag="p" class="license" scope="global">
        <template #license>
          <a :href="`${repo}/blob/main/LICENSE`">{{ $t('page.footer.mit') }}</a>
        </template>
      </i18n-t>
    </footer>
  </template>
</template>

<style scoped>
.book {
  display: grid;
  max-width: 1440px;
  gap: 48px;
  margin: 0 auto;
  padding: 0 40px;
  grid-template-columns: 220px minmax(0, 1fr);
}

.side {
  padding-top: 96px;
}

.footer {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  max-width: 1440px;
  margin: 0 auto;
  padding: 160px 40px 72px;
  color: var(--muted);
  font-size: 15px;
}

.mark {
  margin-bottom: 6px;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 26px;
}

.footer p {
  margin: 0;
}

.heart {
  margin: 0 2px;
  color: var(--bad);
  vertical-align: -0.12em;
}

.footer a {
  color: var(--ink-2);
  text-decoration: none;
}

.footer a:hover {
  color: var(--ink);
}

@media (max-width: 1000px) {
  .book {
    padding: 0 16px;
    grid-template-columns: minmax(0, 1fr);
  }

  .side {
    display: none;
  }

  .footer {
    padding: 120px 20px calc(48px + env(safe-area-inset-bottom));
  }
}
</style>
