import { nextTick, ref, watch } from 'vue'

export type ThemeName = 'dark' | 'light'

const KEY = 'injeca:theme'

function stored(): ThemeName | undefined {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'dark' || value === 'light' ? value : undefined
  }
  catch {
    return undefined
  }
}

const system = window.matchMedia('(prefers-color-scheme: dark)')
// `?theme=dark` wins, for screenshots of the banner. Then the choice of the viewer, then the system. Paper is the default.
const forced = new URLSearchParams(location.search).get('theme')

/** The theme of the page. index.html sets the attribute before the first paint, so the page never flashes. */
export const theme = ref<ThemeName>(forced === 'light' || forced === 'dark' ? forced : stored() ?? (system.matches ? 'dark' : 'light'))

watch(theme, (value) => {
  document.documentElement.dataset.theme = value
}, { immediate: true })

system.addEventListener('change', (event) => {
  if (!forced && !stored())
    theme.value = event.matches ? 'dark' : 'light'
})

let settle = 0

/**
 * Switches the theme in one step. Without care, each element runs its own color transition, at its own speed, and a
 * quick toggle makes the page flicker. So the transitions of the elements stay off for the switch, and the browser
 * crossfades the whole page once, with a view transition where it has one.
 */
export function toggleTheme(): void {
  const next = theme.value === 'dark' ? 'light' : 'dark'
  try {
    localStorage.setItem(KEY, next)
  }
  catch {}

  const root = document.documentElement
  root.classList.add('theme-switching')
  cancelAnimationFrame(settle)
  const apply = async () => {
    theme.value = next
    await nextTick()
  }
  const done = () => {
    // Two frames: the first paints the new colors, the second lets the transitions come back without running.
    settle = requestAnimationFrame(() => (settle = requestAnimationFrame(() => root.classList.remove('theme-switching'))))
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!reduced && 'startViewTransition' in document) {
    document.startViewTransition(apply).finished.finally(done)
  }
  else {
    void apply().then(done)
  }
}
