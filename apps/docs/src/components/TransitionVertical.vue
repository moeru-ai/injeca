<script setup lang="ts">
// Opens and closes its child by height, with the Web Animations API. A toggle in the middle of a transition
// reverses it, so a quick click never jumps. From TransitionVertical of moeru-ai/airi, after
// https://stackoverflow.com/a/71426342/22392721.

const props = withDefaults(defineProps<{ duration?: number, easing?: string }>(), {
  duration: 280,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
})

const CLOSED = '0px'

let animation: Animation | undefined
let last: HTMLElement | undefined

/** The full height of the element, measured out of sight at its real width. */
function measure(element: HTMLElement): string {
  const { width } = getComputedStyle(element)
  const saved = { width: element.style.width, position: element.style.position, visibility: element.style.visibility }
  element.style.width = width
  element.style.position = 'absolute'
  element.style.visibility = 'hidden'
  element.style.height = ''
  const { height } = getComputedStyle(element)
  Object.assign(element.style, saved)
  return height
}

function frames(element: HTMLElement, height: string): Keyframe[] {
  const style = getComputedStyle(element)
  return [
    { height: CLOSED, opacity: 0, paddingTop: CLOSED, paddingBottom: CLOSED, marginTop: CLOSED, marginBottom: CLOSED },
    { height, opacity: 1, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginTop: style.marginTop, marginBottom: style.marginBottom },
  ]
}

/** A transition in progress on the same element turns around, instead of starting again from its end. */
function reverse(element: HTMLElement, done: () => void): boolean {
  if (element !== last || animation?.playState !== 'running')
    return false
  animation.onfinish = () => {
    element.style.overflow = ''
    done()
  }
  animation.reverse()
  return true
}

function run(element: HTMLElement, keyframes: Keyframe[], done: () => void): void {
  last = element
  element.style.overflow = 'hidden'
  animation = element.animate(keyframes, { duration: props.duration, easing: props.easing })
  animation.onfinish = () => {
    element.style.overflow = ''
    done()
  }
}

function onEnter(element: Element, done: () => void): void {
  const target = element as HTMLElement
  if (reverse(target, done))
    return
  run(target, frames(target, measure(target)), done)
}

function onLeave(element: Element, done: () => void): void {
  const target = element as HTMLElement
  if (reverse(target, done))
    return
  run(target, frames(target, getComputedStyle(target).height).reverse(), done)
}
</script>

<template>
  <Transition :css="false" @enter="onEnter" @leave="onLeave">
    <slot />
  </Transition>
</template>
