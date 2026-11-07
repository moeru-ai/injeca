// The locales of the page, organized as in moeru-ai/airi: a folder for each locale, with a YAML file for each part.
// English is the source and has every message. Another locale leaves out a message that reads the same.
//
// `content.yaml` is not made of messages: it holds the teaching text of a locale by path, and i18n.ts reads it with
// `text()`. Its English stays beside the code that runs it, and its strings hold code with braces, which the message
// syntax of vue-i18n would take for placeholders.

import en from './en'
import zhHans from './zh-Hans'
import zhHansContent from './zh-Hans/content.yaml'

/** The name of each locale, in itself. */
export const LOCALES = {
  'en': 'English',
  'zh-Hans': '简体中文',
} as const

/** The messages of each locale. The keys are plain strings, so the types do not follow the YAML. */
export const MESSAGES: Record<keyof typeof LOCALES, Record<string, any>> = {
  'en': en,
  'zh-Hans': zhHans,
}

export const CONTENT: Record<keyof typeof LOCALES, unknown> = {
  'en': undefined,
  'zh-Hans': zhHansContent,
}
