<script setup lang="ts">
import type { Timeline } from 'animejs'
import type { BufferGeometry } from 'three'

import type { Cell } from './scene'

import { createTimeline } from 'animejs'
import { Color, Euler, Group, Mesh, PerspectiveCamera, Quaternion, Raycaster, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer } from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'

import { text } from '../i18n'
import { theme } from '../theme'
import { BATCH_OF, BATCHES, byId, colorOf, ENTRY, LEVELS, REGISTERED, UNITS, STEPS, TIMES, usedBy } from './scene'

/**
 * The hero: how injeca works.
 *
 * The registry is a slow conveyor of pieces, one for each unit, all grey. resolve() is the entry of the graph:
 * a map shows it, and walks back from it to what it needs. The pieces it needs light up on the conveyor and take
 * their colors. Then each batch leaves the conveyor at once and builds, the leaves first, and the pieces lock into
 * one cube. Only the whole cube is app: resolve() returns. stop() sends the pieces back, the users first.
 *
 * Point at a piece or a node of the map to read what it is. `at` draws app, whole, without motion.
 */
const props = withDefaults(defineProps<{
  at?: number
  /** Where the scene starts, as a part of the width. The left of the canvas stays free for text that floats over it. */
  left?: number
  /**
   * For an animated banner: the scene does not run on its own. The capture script calls `__captureAt(i)` for each
   * frame of `__captureFrames`, and the scene draws that exact moment of the loop.
   */
  scrub?: boolean
}>(), { left: 0 })

const still = props.at !== undefined
/** The frames of an animated banner, a second each. */
const SCRUB_FPS = 15
/** In scrub mode, how far the current step has gone, from 0 to 1. The bar of the step shows it. */
const scrubbed = ref<number>()

/** What the page shows around the scene. The timeline sets it. */
const ui = reactive({
  phase: 0,
  map: false,
  /** The nodes of the map that the walk from the entry reached, and its edges, as `<user>><need>`. */
  found: new Set<string>(),
  traced: new Set<string>(),
  batches: false,
  building: new Set<string>(),
  built: new Set<string>(),
  app: false,
})

function resetState(): void {
  Object.assign(ui, { phase: 0, map: false, batches: false, app: false })
  ui.found.clear()
  ui.traced.clear()
  ui.building.clear()
  ui.built.clear()
}

function finalState(): void {
  Object.assign(ui, { phase: 4, map: true, batches: true, app: true })
  ui.found.add(ENTRY.id)
  for (const id of BATCH_OF.keys()) {
    ui.found.add(id)
    ui.built.add(id)
  }
  for (const [user, needs] of [[ENTRY.id, ENTRY.needs], ...UNITS.filter(s => !s.unused).map(s => [s.id, s.needs] as const)] as const) {
    for (const need of needs)
      ui.traced.add(`${user}>${need}`)
  }
}

// The three scene ------------------------------------------------------------------------------------------------

/** All pieces in the cube share one turn, so they show how they fit. */
const TURN = new Euler(-0.5, 0.72, 0, 'YXZ')
const TURN_Q = new Quaternion().setFromEuler(TURN)
const CELL = 0.72
const SHELF_CELL = 0.34
const SHELF_GAP = 1.55
/** On a narrow screen: half the width of the scene, in units of the scene, and the height of the cube, as a part of the screen from the top. */
const NARROW_HALF_WIDTH = 3.3
const NARROW_CUBE_AT = 0.52
/** Where the middle of the cube is. */
const CUBE = new Vector3(-1.1, 0.55, 0)

const centroid = (cells: readonly Cell[]) => cells.reduce((sum, cell) => sum.add(new Vector3(...cell)), new Vector3()).divideScalar(cells.length)
const packedOf = (cells: readonly Cell[]) => centroid(cells).subScalar(1).multiplyScalar(CELL).applyEuler(TURN).add(CUBE)

/**
 * What the timeline moves for each piece. `t` goes from the conveyor (0) to the cube (1). `color` goes from grey to
 * the color of the piece. `lift` raises a piece on the conveyor when the walk finds it. `dim` greys out a piece that
 * the entry does not need.
 */
interface PieceState { t: number, color: number, glow: number, lift: number, dim: number }
const pieces = new Map<string, PieceState>(UNITS.map(unit => [unit.id, { t: 0, color: 0, glow: 0, lift: 0, dim: 0 }]))
const ring = reactive({ scale: 0, opacity: 0 })

const VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`

// A piece is grey until the walk finds it, then it takes its color. The glow is the blue of a new instance at work.
const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uGrey;
uniform vec3 uNew;
uniform float uColorMix;
uniform float uGlow;
uniform float uHover;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec3 n = normalize(vNormal);
  float rim = pow(1.0 - abs(dot(n, vView)), 2.2);
  float light = 0.74 + 0.26 * max(dot(n, normalize(vec3(-0.4, 0.8, 0.6))), 0.0);
  vec3 color = mix(mix(uGrey, uColor, uColorMix) * light, uNew, uGlow * 0.4) + uNew * rim * (uGlow * 0.9 + uHover * 0.6);
  gl_FragColor = vec4(color, uOpacity);
}`

/** One rounded cube for each cell, around the middle of the cells. The gaps between cells show the cuts. */
function blocksOf(cells: readonly Cell[]): BufferGeometry {
  const middle = centroid(cells)
  return mergeGeometries(cells.map(cell => new RoundedBoxGeometry(0.93, 0.93, 0.93, 3, 0.13).translate(cell[0] - middle.x, cell[1] - middle.y, cell[2] - middle.z)))
}

function cssColor(name: string): Color {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const probe = document.createElement('span')
  probe.style.color = value
  document.body.append(probe)
  const rgb = getComputedStyle(probe).color
  probe.remove()
  const [r, g, b] = rgb.match(/[\d.]+/g)!.map(Number)
  // Colors in oklch come back as color(srgb ...) with channels from 0 to 1.
  return rgb.startsWith('color(') ? new Color(r!, g!, b!) : new Color(r! / 255, g! / 255, b! / 255)
}

const smooth = (x: number) => x * x * (3 - 2 * x)

const host = ref<HTMLElement>()
const canvas = ref<HTMLCanvasElement>()
const root = ref<HTMLElement>()

let renderer: WebGLRenderer | undefined
let timeline: Timeline | undefined
let frame = 0
let observer: ResizeObserver | undefined
let seen: IntersectionObserver | undefined
let stopWatching: (() => void) | undefined

/**
 * Labels that follow the scene: the names under the pieces on the conveyor, app over the cube, and the ring of app.
 * The render loop moves them by their style, not through Vue, so that a frame costs no reactive update.
 */
const labelElements = new Map<string, HTMLElement>()
const appLabel = ref<HTMLElement>()
const ringMark = ref<HTMLElement>()

/** The unit under the pointer, in the scene or on the map, and where to show its card. */
const tip = ref<{ id: string, x: number, y: number }>()
let paused = false
/** Whether the timeline plays. The bar of the step in the caption fills only while it does. */
const playing = ref(false)

function hover(id: string | undefined, x: number, y: number): void {
  tip.value = id ? { id, x, y } : undefined
  paused = !!id
  if (id)
    timeline?.pause()
  else
    timeline?.play()
  playing.value = !paused && frame !== 0
}

function hoverElement(id: string | undefined, event?: Event): void {
  if (!id || !event || id === ENTRY.id)
    return hover(undefined, 0, 0)
  const base = root.value!.getBoundingClientRect()
  const rect = (event.currentTarget as Element).getBoundingClientRect()
  hover(id, rect.left + rect.width / 2 - base.left, rect.top - base.top - 8)
}

onMounted(() => {
  const scene = new Scene()
  const camera = new PerspectiveCamera(30, 1, 0.1, 100)
  renderer = new WebGLRenderer({ canvas: canvas.value!, antialias: true, alpha: true, preserveDrawingBuffer: still || props.scrub })
  // The canvas covers the whole hero, so a full Retina ratio would paint four times the pixels for little gain.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  const group = new Group()
  scene.add(group)

  const grey = new Color()
  const accent = new Color()
  const colors = new Map(UNITS.map(unit => [unit.id, new Color()]))
  const meshes = new Map<string, Mesh<BufferGeometry, ShaderMaterial>>()
  for (const unit of UNITS) {
    const mesh = new Mesh(blocksOf(unit.cells), new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      uniforms: {
        uColor: { value: colors.get(unit.id) },
        uGrey: { value: grey },
        uNew: { value: accent },
        uColorMix: { value: 0 },
        uGlow: { value: 0 },
        uHover: { value: 0 },
        uOpacity: { value: 1 },
      },
    }))
    mesh.userData.id = unit.id
    meshes.set(unit.id, mesh)
    group.add(mesh)
  }

  function paint(): void {
    grey.copy(cssColor('--control-3'))
    accent.copy(cssColor('--new'))
    for (const unit of UNITS)
      colors.get(unit.id)!.set(colorOf(unit.id) ?? '#888888')
  }
  paint()
  // After the page has the new theme, in the same frame, so the canvas never lags behind the page.
  watch(theme, paint, { flush: 'post' })

  // The camera frames the cube and the conveyor in the part of the canvas right of `left`.
  let halfWidth = 5
  let width = 1
  let height = 1
  /** Where the conveyor runs. On a narrow screen it runs closer under the cube, so the map has the corner below it. */
  let shelfY = -2.55
  /** The middle of the part of the canvas that the scene owns, in the space of the group. */
  let regionMiddle = 0
  function resize(): void {
    width = host.value!.clientWidth
    height = host.value!.clientHeight
    renderer!.setSize(width, height, false)
    camera.aspect = width / height
    const tan = Math.tan((camera.fov * Math.PI) / 360)
    if (width < 960) {
      // The scene fills the screen, and the text floats above the cube: the cube sits a bit under the middle.
      const visible = NARROW_HALF_WIDTH
      const distance = visible / (tan * camera.aspect)
      camera.position.set(0, 0, distance)
      camera.updateProjectionMatrix()
      halfWidth = visible
      shelfY = -1.7
      const halfHeight = distance * tan
      group.position.set(-CUBE.x, (1 - 2 * NARROW_CUBE_AT) * halfHeight - CUBE.y, 0)
      regionMiddle = CUBE.x
      return
    }
    const left = props.left
    const distance = Math.max(4.1 / tan, 4.6 / ((1 - left) * tan * camera.aspect))
    camera.position.set(0, 0, distance)
    camera.updateProjectionMatrix()
    const visible = distance * tan * camera.aspect
    halfWidth = visible * (1 - left)
    shelfY = -2.55
    group.position.set(visible * left, 0, 0)
    regionMiddle = 0
  }
  resize()
  observer = new ResizeObserver(resize)
  observer.observe(host.value!)

  const total = REGISTERED.length * SHELF_GAP
  let scroll = 0
  let last = 0
  /**
   * How much a piece at `x` shows. Every piece fades out before it reaches an edge of the part of the canvas that the
   * scene owns, so none passes under the text: one on the conveyor, and one in flight to the cube or back.
   */
  function edgeFade(x: number): number {
    return smooth(Math.min(1, Math.max(0, (halfWidth - 0.6 - Math.abs(x - regionMiddle)) / 1.1)))
  }

  /** Where the piece of `id` sits on the conveyor now. The conveyor loops around the middle of the scene. */
  function shelfOf(id: string): { position: Vector3, fade: number } {
    const i = REGISTERED.indexOf(id)
    const x = ((i * SHELF_GAP - scroll) % total + total) % total - total / 2 + regionMiddle
    const edge = edgeFade(x)
    return { position: new Vector3(x, shelfY, 0.4), fade: edge }
  }

  const froms = new Map<string, Vector3>()
  const lastT = new Map<string, number>()
  const raycaster = new Raycaster()
  const ndc = new Vector2()
  const pointerAt = { x: 0, y: 0 }
  let inside = false
  let sceneHover: string | undefined
  const projected = new Vector3()
  const spin = new Quaternion()
  const turn = new Euler()
  const packed = new Map(UNITS.map(unit => [unit.id, packedOf(unit.cells)]))
  const appTop = CUBE.clone().add(new Vector3(0, 1.6, 0))

  /** Puts an element at the screen point of `point`, in the space of the group. */
  function place(element: HTMLElement | undefined, point: Vector3, dy = 0, opacity?: number): void {
    if (!element)
      return
    projected.copy(point).applyMatrix4(group.matrixWorld).project(camera)
    element.style.left = `${(projected.x + 1) / 2 * width}px`
    element.style.top = `${(1 - projected.y) / 2 * height + dy}px`
    if (opacity !== undefined)
      element.style.opacity = String(opacity)
  }

  function render(time: number): void {
    const dt = last ? Math.min(0.05, (time - last) / 1000) : 0
    last = time
    // A scrubbed frame takes the conveyor from the time of the loop, so each frame is the same on each run.
    if (props.scrub)
      scroll = time / 1000 * 0.45
    else if (!paused && !still)
      scroll += dt * 0.45
    const t = time / 1000
    group.rotation.y = still ? 0.04 : Math.sin(t * 0.25) * 0.12
    group.rotation.x = still ? -0.02 : Math.sin(t * 0.19) * 0.04

    group.updateMatrixWorld()
    for (const unit of UNITS) {
      const id = unit.id
      const state = pieces.get(id)!
      const mesh = meshes.get(id)!
      const shelf = shelfOf(id)

      // A piece in flight keeps the place where it left the conveyor, so a loop of the conveyor never makes it jump.
      const previous = lastT.get(id) ?? 0
      if (state.t > 0 && (previous === 0 || (previous === 1 && state.t < 1)))
        froms.set(id, shelf.position.clone())
      lastT.set(id, state.t <= 0 ? 0 : state.t >= 1 ? 1 : state.t)
      const from = state.t > 0 ? froms.get(id) ?? shelf.position : shelf.position
      const p = smooth(Math.min(1, Math.max(0, state.t)))

      const cube = unit.unused ? shelf.position : packed.get(id)!
      mesh.position.lerpVectors(from, cube, p)
      mesh.position.y += Math.sin(Math.PI * p) * 1.1 + state.lift * 0.32 * (1 - p)
      mesh.scale.setScalar((SHELF_CELL + (CELL - SHELF_CELL) * p) * (tip.value?.id === id ? 1.08 : 1))
      spin.setFromEuler(turn.set(0, t * 0.6 + REGISTERED.indexOf(id), 0))
      mesh.quaternion.copy(spin).multiply(TURN_Q).slerp(TURN_Q, p)

      const uniforms = mesh.material.uniforms
      uniforms.uColorMix!.value = state.color
      uniforms.uGlow!.value = state.glow
      uniforms.uHover!.value = tip.value?.id === id ? 1 : 0
      const fade = edgeFade(mesh.position.x)
      uniforms.uOpacity!.value = fade * (1 - state.dim * 0.55)
      mesh.visible = uniforms.uOpacity!.value > 0.01

      place(labelElements.get(id), mesh.position, 40, fade * (1 - p) * (1 - state.dim * 0.5))
    }
    place(appLabel.value, appTop)
    place(ringMark.value, CUBE)

    let id: string | undefined
    if (inside) {
      raycaster.setFromCamera(ndc, camera)
      id = raycaster.intersectObjects([...meshes.values()].filter(mesh => mesh.visible))[0]?.object.userData.id as string | undefined
    }
    if (id !== sceneHover) {
      sceneHover = id
      hover(id, pointerAt.x, pointerAt.y)
    }
    renderer!.render(scene, camera)
  }

  canvas.value!.addEventListener('pointermove', (event) => {
    const box = canvas.value!.getBoundingClientRect()
    ndc.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1)
    const base = root.value!.getBoundingClientRect()
    pointerAt.x = event.clientX - base.left
    pointerAt.y = event.clientY - base.top
    inside = !still
    if (sceneHover)
      tip.value = { id: sceneHover, x: pointerAt.x, y: pointerAt.y }
  })
  canvas.value!.addEventListener('pointerleave', () => {
    inside = false
  })

  if (still || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finalState()
    for (const [id, state] of pieces) {
      const needed = BATCH_OF.has(id)
      Object.assign(state, { t: needed ? 1 : 0, color: needed ? 1 : 0, dim: needed ? 0 : 1 })
    }
    scroll = 1.2
    // A few frames, so the size, the palette, and the page settle before a screenshot.
    let frames = 0
    const settle = (time: number) => {
      render(time)
      if (++frames < 6)
        requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
    return
  }

  timeline = buildTimeline()

  if (props.scrub) {
    timeline.pause()
    const line = timeline
    const frames = Math.round(TIMES.end / 1000 * SCRUB_FPS)
    const target = window as unknown as { __captureFrames?: number[], __captureAt?: (i: number) => void }
    target.__captureAt = (i: number) => {
      const ms = i * 1000 / SCRUB_FPS
      line.seek(ms)
      const start = STARTS.findLast(at => at <= ms) ?? 0
      scrubbed.value = Math.min(1, (ms - start) / durations[STARTS.indexOf(start)]!)
      render(ms)
    }
    // Wait for the palette and the size, then offer the frames.
    requestAnimationFrame(() => requestAnimationFrame(() => (target.__captureFrames = Array.from({ length: frames }, () => 1000 / SCRUB_FPS))))
    return
  }
  const loop = (time: number) => {
    render(time)
    frame = requestAnimationFrame(loop)
  }

  // The scene runs only while the hero is on screen and the tab is visible. Otherwise it costs nothing.
  let onScreen = true
  function run(): void {
    const should = onScreen && !document.hidden
    if (should && !frame) {
      last = 0
      frame = requestAnimationFrame(loop)
      if (!paused)
        timeline?.play()
    }
    else if (!should && frame) {
      cancelAnimationFrame(frame)
      frame = 0
      timeline?.pause()
    }
    playing.value = !paused && frame !== 0
  }
  seen = new IntersectionObserver(([entry]) => {
    onScreen = !!entry?.isIntersecting
    run()
  })
  seen.observe(root.value!)
  document.addEventListener('visibilitychange', run)
  stopWatching = () => document.removeEventListener('visibilitychange', run)
  run()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  seen?.disconnect()
  stopWatching?.()
  timeline?.revert()
  renderer?.dispose()
})

function buildTimeline(): Timeline {
  const line = createTimeline({ loop: true, defaults: { ease: 'inOutCubic' } })
  const at = (time: number, callback: () => void) => line.call(callback, time)
  const piece = (id: string) => pieces.get(id)!

  // 1. Registered: grey pieces on the conveyor.
  at(TIMES.registered, resetState)

  // 2. Asked for: the map shows the entry, and its edges to what it needs. Those pieces rise on the conveyor.
  at(TIMES.asked, () => {
    ui.phase = 1
    ui.map = true
    ui.found.add(ENTRY.id)
  })
  let walk = TIMES.asked + 500
  for (const need of ENTRY.needs) {
    at(walk, () => {
      ui.traced.add(`${ENTRY.id}>${need}`)
      ui.found.add(need)
    })
    line.add(piece(need), { lift: 1, duration: 400, ease: 'outBack(1.6)' }, walk)
    walk += 260
  }

  // 3. Solved: the walk goes on to the leaves. What is needed takes its color. The rest greys out.
  at(TIMES.solved, () => (ui.phase = 2))
  walk = TIMES.solved + 300
  for (const level of LEVELS) {
    for (const id of level) {
      for (const need of byId(id).needs) {
        at(walk, () => {
          ui.traced.add(`${id}>${need}`)
          ui.found.add(need)
        })
        line.add(piece(need), { lift: 1, duration: 400, ease: 'outBack(1.6)' }, walk)
        walk += 220
      }
    }
  }
  at(walk + 200, () => (ui.batches = true))
  for (const unit of UNITS) {
    if (unit.unused)
      line.add(piece(unit.id), { dim: 1, duration: 500 }, walk + 200)
    else
      line.add(piece(unit.id), { color: 1, duration: 600 }, walk + 200)
  }

  // 4. Built: each batch leaves the conveyor at once, glows while it builds, and locks into the cube.
  at(TIMES.built, () => (ui.phase = 3))
  BATCHES.forEach((batch, b) => {
    const start = TIMES.built + b * 1700
    at(start, () => batch.forEach(id => ui.building.add(id)))
    batch.forEach((id, i) => {
      line.add(piece(id), { t: 1, lift: 0, duration: 1000, ease: 'inOutQuad' }, start + i * 60)
        .add(piece(id), { glow: [0, 1, 0], duration: 1400, ease: 'inOutSine' }, start + i * 60)
    })
    at(start + 1300, () => batch.forEach((id) => {
      ui.building.delete(id)
      ui.built.add(id)
    }))
  })

  // 5. app: the cube is whole, and resolve() returns.
  at(TIMES.app, () => {
    ui.phase = 4
    ui.app = true
  })
  line.add(ring, { scale: [0.6, 1.6], opacity: [0, 0.7, 0], duration: 1200, ease: 'outQuad' }, TIMES.app)
  for (const id of BATCH_OF.keys())
    line.add(piece(id), { glow: [0, 0.7, 0], duration: 1100, ease: 'inOutSine' }, TIMES.app)

  // 6. Stopped: what uses others goes back first, then what it uses.
  at(TIMES.stopped, () => {
    ui.phase = 5
    ui.app = false
  })
  ;[...BATCHES].reverse().forEach((batch, b) => {
    const start = TIMES.stopped + 300 + b * 1100
    at(start, () => batch.forEach(id => ui.built.delete(id)))
    batch.forEach((id, i) => line.add(piece(id), { t: 0, duration: 900, ease: 'inOutQuad' }, start + i * 50))
  })
  for (const unit of UNITS)
    line.add(piece(unit.id), { color: 0, dim: 0, lift: 0, duration: 600 }, TIMES.end - 900)
  at(TIMES.end - 900, () => (ui.map = false))
  at(TIMES.end, () => {})
  return line
}

// The map: the graph as plain shapes. The entry is a diamond on the right; the batches are columns to its left.
const MAP_W = 300
const MAP_H = 214
const columns = [...BATCHES, [ENTRY.id]]
const mapNodes = columns.flatMap((column, c) => column.map((id, i) => ({
  id,
  entry: id === ENTRY.id,
  x: 30 + c * ((MAP_W - 60) / (columns.length - 1)),
  y: column.length === 1 ? MAP_H / 2 - 4 : 34 + i * ((MAP_H - 66) / (column.length - 1)),
})))
const mapPlace = (id: string) => mapNodes.find(node => node.id === id)!
const mapEdges = [
  ...ENTRY.needs.map(need => ({ id: `${ENTRY.id}>${need}`, from: mapPlace(need), to: mapPlace(ENTRY.id) })),
  ...UNITS.filter(unit => !unit.unused).flatMap(unit => unit.needs.map(need => ({ id: `${unit.id}>${need}`, from: mapPlace(need), to: mapPlace(unit.id) }))),
]
const batchHeads = BATCHES.map((batch, b) => ({ n: b + 1, x: mapPlace(batch[0]!).x }))

const tipUnit = computed(() => tip.value && byId(tip.value.id))
const { t } = useI18n()
const tipState = computed(() => {
  const id = tip.value?.id
  if (!id)
    return ''
  if (byId(id).unused)
    return ui.phase >= 2 ? t('hero.state.pending') : t('hero.state.registry')
  const n = BATCH_OF.get(id)
  if (ui.built.has(id))
    return t('hero.state.built', { n })
  if (ui.building.has(id))
    return t('hero.state.building', { n })
  return ui.found.has(id) ? t('hero.state.needed', { n }) : t('hero.state.registry')
})
const tipPlace = computed(() => {
  const width = root.value?.clientWidth ?? 0
  const { x = 0, y = 0 } = tip.value ?? {}
  return { left: `${Math.min(Math.max(8, x - 130), width - 268)}px`, top: `${y > 260 ? y - 190 : y + 18}px` }
})

/** The steps of the story in the locale of the page. The code of a step stays as it is. */
const steps = computed(() => STEPS.map((step, i) => ({ ...step, title: text(`hero.steps.${i}.title`, step.title), text: text(`hero.steps.${i}.text`, step.text) })))
/** How long each step lasts, in milliseconds. */
const STARTS = [TIMES.registered, TIMES.asked, TIMES.solved, TIMES.built, TIMES.app, TIMES.stopped, TIMES.end]
const durations = STEPS.map((_, i) => STARTS[i + 1]! - STARTS[i]!)
</script>

<template>
  <div ref="root" class="hero-scene" :class="{ still }" :style="{ '--left': left }">
    <div ref="host" class="canvas-wrap">
      <canvas ref="canvas" :aria-label="steps.map(step => `${step.title}: ${step.code} ${step.text}`).join(' ')" role="img" />
    </div>

    <div class="region">
      <span
        v-for="unit in UNITS"
        :key="unit.id"
        :ref="(el) => { if (el) labelElements.set(unit.id, el as HTMLElement) }"
        class="label mono"
      >{{ unit.id }}</span>

      <span v-show="ui.app" ref="ringMark" class="ring-mark" :style="{ transform: `translate(-50%, -50%) scale(${ring.scale})`, opacity: ring.opacity }" aria-hidden="true" />
      <div ref="appLabel" class="app-label" :class="{ on: ui.app }">
        <span class="app-name">app</span>
        <span class="app-note mono">{{ $t('hero.returned') }}</span>
      </div>

      <!-- The map: the graph as plain shapes, and the walk back from the entry. -->
      <figure class="map" :class="{ on: ui.map }" :aria-label="$t('hero.map')">
        <svg :viewBox="`0 0 ${MAP_W} ${MAP_H}`" :width="MAP_W" :height="MAP_H">
          <g v-if="ui.batches">
            <text v-for="head in batchHeads" :key="head.n" class="batch mono" :x="head.x" y="12" text-anchor="middle">{{ $t('hero.batch', { n: head.n }) }}</text>
          </g>
          <line
            v-for="edge in mapEdges"
            :key="edge.id"
            class="edge"
            :class="{ traced: ui.traced.has(edge.id) }"
            :x1="edge.from.x + 9"
            :y1="edge.from.y"
            :x2="edge.to.x - 10"
            :y2="edge.to.y"
          />
          <g
            v-for="node in mapNodes"
            :key="node.id"
            class="node"
            :class="{ entry: node.entry, found: ui.found.has(node.id), building: ui.building.has(node.id), built: ui.built.has(node.id) || (node.entry && ui.app) }"
            @mouseenter="hoverElement(node.id, $event)"
            @mouseleave="hoverElement(undefined)"
          >
            <rect v-if="node.entry" :x="node.x - 9" :y="node.y - 9" width="18" height="18" rx="3" :transform="`rotate(45 ${node.x} ${node.y})`" />
            <circle v-else :cx="node.x" :cy="node.y" r="8" :style="{ '--piece': colorOf(node.id) }" />
            <text :x="node.x" :y="node.y + 23" class="name mono" text-anchor="middle">{{ node.entry ? 'resolve()' : node.id }}</text>
          </g>
        </svg>
      </figure>

      <p v-if="!still" class="caption">
        <!-- One bar for each step. The steps before are full, and the bar of this step fills while it plays. -->
        <span class="bars" aria-hidden="true">
          <span v-for="(step, i) in steps" :key="step.title" class="bar" :class="{ done: i < ui.phase }">
            <span v-if="i === ui.phase && scrubbed !== undefined" class="fill scrubbed" :style="{ transform: `scaleX(${scrubbed})` }" />
            <span v-else-if="i === ui.phase" :key="`${ui.phase}`" class="fill" :class="{ held: !playing }" :style="{ animationDuration: `${durations[i]}ms` }" />
          </span>
        </span>
        <span class="n mono">0{{ ui.phase + 1 }}</span>
        <span class="title">{{ steps[ui.phase]!.title }}</span>
        <code v-if="steps[ui.phase]!.code">{{ steps[ui.phase]!.code }}</code>
        <span class="text">{{ steps[ui.phase]!.text }}</span>
      </p>
    </div>

    <div v-if="tip && tipUnit" class="tip" :style="tipPlace">
      <p class="tip-name mono">
        {{ tipUnit.id }}
      </p>
      <p class="tip-role">
        {{ text(`hero.roles.${tipUnit.id}`, tipUnit.role) }}
      </p>
      <p v-if="tipUnit.needs.length" class="tip-row">
        <span>{{ $t('hero.needs') }}</span> <code>{{ tipUnit.needs.join(', ') }}</code>
      </p>
      <p v-if="usedBy(tipUnit.id).length" class="tip-row">
        <span>{{ $t('hero.used-by') }}</span> <code>{{ usedBy(tipUnit.id).join(', ') }}</code>
      </p>
      <p class="tip-state">
        {{ tipState }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.hero-scene {
  position: relative;
  height: 100%;
}

.canvas-wrap {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

/* The part of the hero right of the text, where the labels, the map, and the caption float over the canvas. */
.region {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.map,
.caption {
  pointer-events: auto;
}

.label {
  position: absolute;
  top: 0;
  left: 0;
  opacity: 0;
  transform: translateX(-50%);
  color: var(--ink-2);
  font-size: 11.5px;
  white-space: nowrap;
}

.app-label {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transform: translate(-50%, -100%) translateY(8px);
  transition:
    opacity 0.4s,
    transform 0.5s cubic-bezier(0.2, 0, 0, 1);
}

.app-label.on {
  opacity: 1;
  transform: translate(-50%, -100%);
}

.app-name {
  font-family: var(--font-display);
  font-size: 30px;
}

.app-note {
  color: var(--new);
  font-size: 12px;
}

.ring-mark {
  position: absolute;
  width: 220px;
  height: 220px;
  border: 2px solid var(--new);
  border-radius: 50%;
  pointer-events: none;
}

.map {
  position: absolute;
  top: 84px;
  right: 40px;
  margin: 0;
  padding: 12px 14px 6px;
  border-radius: 20px;
  /* No backdrop blur: it would composite again on each frame of the canvas under it. */
  background: color-mix(in srgb, var(--paper) 92%, transparent);
  opacity: 0;
  transition: opacity 0.5s;
}

.map.on {
  opacity: 1;
}

.map svg {
  display: block;
  overflow: visible;
}

.edge {
  stroke: var(--line);
  stroke-dasharray: 2 5;
  stroke-linecap: round;
  stroke-width: 1.5;
  transition: stroke 0.3s;
}

.edge.traced {
  stroke: var(--ink-2);
  stroke-dasharray: none;
}

.node circle,
.node rect {
  fill: var(--control-2);
  stroke: transparent;
  stroke-width: 2;
  transition:
    fill 0.35s,
    stroke 0.35s;
}

.node.found circle,
.node.found rect {
  fill: var(--surface);
  stroke: var(--new);
}

.node.building circle {
  fill: var(--new-soft);
  stroke: var(--new);
  animation: building 0.6s ease-in-out infinite alternate;
}

@keyframes building {
  to {
    stroke-opacity: 0.3;
  }
}

.node.built circle {
  fill: var(--piece);
  stroke: transparent;
}

.node.entry.built rect {
  fill: var(--new-fill);
  stroke: transparent;
}

.node .name {
  fill: var(--muted);
  font-size: 11px;
}

.node.found .name {
  fill: var(--ink);
}

.batch {
  fill: var(--new);
  font-size: 10.5px;
}

.caption {
  position: absolute;
  right: 40px;
  bottom: 22px;
  left: calc(var(--left) * 100%);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 0;
  font-size: 15px;
}

.bars {
  display: grid;
  gap: 4px;
  flex-basis: 100%;
  grid-template-columns: repeat(6, minmax(0, 48px));
  margin-bottom: 6px;
}

.bar {
  height: 3px;
  flex: 1;
  overflow: hidden;
  border-radius: 2px;
  background: var(--line);
}

.bar.done {
  background: var(--ink-2);
}

.fill {
  display: block;
  height: 100%;
  background: var(--new);
  transform-origin: 0 50%;
  animation: fill linear forwards;
}

.fill.scrubbed {
  animation: none;
}

.fill.held {
  animation-play-state: paused;
}

@keyframes fill {
  from {
    transform: scaleX(0);
  }

  to {
    transform: scaleX(1);
  }
}

.caption .n {
  color: var(--new);
  font-size: 12px;
}

.caption .title {
  font-family: var(--font-display);
  font-size: 18px;
}

.caption code {
  font-size: 13px;
}

.caption .text {
  color: var(--ink-2);
}

.tip {
  position: absolute;
  z-index: 3;
  width: 260px;
  padding: 12px 14px;
  border-radius: 16px;
  background: var(--surface);
  box-shadow:
    0 1px 2px var(--shadow-strong),
    0 12px 32px var(--shadow-strong);
  color: var(--ink);
  font-size: 13.5px;
  line-height: 1.45;
  pointer-events: none;
}

.tip p {
  margin: 0;
}

.tip-name {
  font-size: 14px;
}

.tip-role {
  margin-top: 4px !important;
  color: var(--ink-2);
}

.tip-row {
  margin-top: 6px !important;
}

.tip-row span {
  color: var(--muted);
}

.tip-row code {
  font-size: 12.5px;
}

.tip-state {
  margin-top: 8px !important;
  color: var(--new);
  font-size: 12.5px;
}

.still .map,
.still .app-label {
  transition: none;
}

/*
 * A narrow screen: the scene fills it. The steps read at the top, under the name of the page, as the text of the
 * first screen. The map keeps to the corner at the bottom right.
 */
@media (max-width: 960px) {
  .map {
    top: auto;
    right: 8px;
    bottom: calc(8px + env(safe-area-inset-bottom));
    padding: 10px 12px 4px;
    transform: scale(0.6);
    transform-origin: 100% 100%;
  }

  .caption {
    top: calc(104px + env(safe-area-inset-top));
    right: 20px;
    bottom: auto;
    left: 20px;
    gap: 4px 10px;
    font-size: 15px;
    line-height: 1.5;
  }

  .bars {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    margin-bottom: 14px;
  }

  .caption .title {
    font-size: 26px;
  }

  .caption code {
    flex-basis: 100%;
    margin-top: 2px;
    font-size: 12px;
  }

  .caption .text {
    flex-basis: 100%;
    margin-top: 2px;
  }

  /* The caption already names app. */
  .app-label {
    display: none;
  }
}
</style>
