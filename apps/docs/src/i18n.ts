import type { I18n } from 'vue-i18n'

import type { LOCALES } from './locales'

import { computed, watch } from 'vue'
import { createI18n } from 'vue-i18n'

import { CONTENT, MESSAGES } from './locales'

export type Locale = keyof typeof LOCALES

/** The locale that has every message. The others leave out a message when it reads the same, and fall back to it. */
const SOURCE: Locale = 'en'
const KEY = 'injeca:locale'

/** Picks a supported locale for a tag such as `zh-CN` or `en-GB`. */
export function resolveLocale(tag: string | null | undefined): Locale | undefined {
  if (!tag)
    return undefined
  const lower = tag.toLowerCase()
  if (lower.startsWith('zh'))
    return 'zh-Hans'
  if (lower.startsWith('en'))
    return 'en'
  return undefined
}

function stored(): Locale | undefined {
  try {
    return resolveLocale(localStorage.getItem(KEY))
  }
  catch {
    return undefined
  }
}

const params = new URLSearchParams(location.search)
// A banner of the README is always English. Then `?lang=`, the choice of the viewer, and the language of the browser.
const initial: Locale = params.has('capture')
  ? SOURCE
  : resolveLocale(params.get('lang')) ?? stored() ?? navigator.languages.map(resolveLocale).find(Boolean) ?? SOURCE

// The type stays plain: inferred from the messages, it goes too deep for the checker.
export const i18n: I18n<Record<string, any>, Record<string, any>, Record<string, any>, string, false> = createI18n({
  legacy: false,
  locale: initial,
  fallbackLocale: SOURCE,
  fallbackWarn: false,
  missingWarn: false,
  messages: MESSAGES,
  missing: (locale: string, key: string): void => {
    // A locale leaves out a message on purpose. Only a message that English lacks is a mistake.
    if (locale === SOURCE)
      console.warn(`[i18n] English has no message for '${key}'. Add it to src/locales/en.`)
  },
})

/** A message outside of a component. Its type is plain, because the overloads of vue-i18n go too deep for the checker. */
export const message = i18n.global.t as unknown as (key: string, named?: Record<string, unknown>) => string

export const locale = computed<Locale>({
  get: () => i18n.global.locale.value as Locale,
  set: (value) => {
    i18n.global.locale.value = value
    try {
      localStorage.setItem(KEY, value)
    }
    catch {}
  },
})

// The browser picks the fallback font for CJK text from the language of the document, so it follows the locale.
watch(locale, (value) => {
  document.documentElement.lang = value
}, { immediate: true })

export function toggleLocale(): void {
  locale.value = locale.value === 'en' ? 'zh-Hans' : 'en'
}

/**
 * The teaching text in the locale of the page. The English lives beside the code that runs it (the chapters, the
 * features, the cheat sheet, and the hero), and the lab records it; a locale gives its own text by path, like
 * `chapters.swap.variants.replace.steps.2.caption`. A path that the locale lacks keeps the English.
 */
export function text(path: string, english: string): string
export function text(path: string, english: string | undefined): string | undefined
export function text(path: string, english: string | undefined): string | undefined {
  let node: unknown = CONTENT[locale.value]
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object')
      return english
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : english
}
