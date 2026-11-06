// Marks the target of an in-page link: it lights up for a moment when the page arrives there, as the
// highlight-targeted-heading plugin of nolebase/integrations does. An element can name the part that lights
// with `data-flash`, for example the header of a chapter.

const CLASS = 'flash'

function flash(id: string): void {
  const target = document.getElementById(id)
  if (!target)
    return
  const element = target.querySelector<HTMLElement>('[data-flash]') ?? target
  element.classList.remove(CLASS)
  // The class goes and comes back, so the animation runs again when the same target is chosen twice.
  void element.offsetWidth
  element.classList.add(CLASS)
}

/** Waits until the smooth scroll ends, so the flash shows where the eye lands. */
function afterScroll(callback: () => void): void {
  let done = false
  const finish = () => {
    if (done)
      return
    done = true
    window.removeEventListener('scrollend', finish)
    callback()
  }
  window.addEventListener('scrollend', finish, { once: true })
  // No scroll happens when the target is on screen already, and Safari has no scrollend before 18.
  setTimeout(finish, 700)
}

export function installTargetFlash(): void {
  document.addEventListener('click', (event) => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]')
    const id = link?.hash.slice(1)
    if (id)
      afterScroll(() => flash(id))
  })
  if (location.hash)
    afterScroll(() => flash(decodeURIComponent(location.hash.slice(1))))
}
