import type { Ref } from 'vue'

import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Tells whether `element` is on screen or close to it. A stage animates only then, so the loops of the many stages
 * on the page cost nothing while the reader is elsewhere.
 */
export function useNear(element: Ref<HTMLElement | undefined>, margin = '200px'): Ref<boolean> {
  const near = ref(false)
  let observer: IntersectionObserver | undefined
  onMounted(() => {
    observer = new IntersectionObserver(([entry]) => {
      near.value = !!entry?.isIntersecting
    }, { rootMargin: margin })
    if (element.value)
      observer.observe(element.value)
  })
  onBeforeUnmount(() => observer?.disconnect())
  return near
}
