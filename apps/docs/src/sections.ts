import { ref } from 'vue'

import { message, text } from './i18n'
import { SCENARIOS } from './lab/scenarios'

/** The sections of the page, in order: the sidebar and the bar on a phone list them. */
export interface Section {
  readonly id: string
  /** The number of a chapter, as two digits. Empty for the other sections. */
  readonly n: string
  /** The message of its name, or for a chapter its short name in English. */
  readonly label: string
}

export const SECTIONS: readonly Section[] = [
  { id: 'getting-started', n: '', label: 'page.nav.getting-started' },
  { id: 'features', n: '', label: 'page.nav.features' },
  { id: 'sandbox', n: '', label: 'page.nav.sandbox' },
  ...SCENARIOS.map((s, i) => ({ id: s.id, n: String(i + 1).padStart(2, '0'), label: s.nav })),
  { id: 'cheat-sheet', n: '', label: 'page.nav.cheat-sheet' },
]

/** The name of a section in the locale of the page. */
export function labelOf(section: Section): string {
  return section.n ? text(`chapters.${section.id}.nav`, section.label) : message(section.label)
}

/** The section that the reader is in: the one that crosses a line a little above the middle of the screen. */
export const activeSection = ref(SECTIONS[0]!.id)

let observer: IntersectionObserver | undefined
let users = 0

/** Starts to follow the sections, for as long as one component uses them. Returns the function that stops. */
export function watchSections(): () => void {
  if (users++ === 0) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting)
          activeSection.value = entry.target.id
      }
    }, { rootMargin: '-40% 0px -55% 0px' })
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id)
      if (element)
        observer.observe(element)
    }
  }
  return () => {
    if (--users === 0)
      observer?.disconnect()
  }
}
