// The code that a user writes for each variant of each chapter, by `<chapter>/<variant>`.
// The steps of scenarios.ts point at its lines, 1-based, so keep the line numbers in mind when you change it.
// It has no imports, so vite.config.ts can highlight it at build time.

export const SAMPLES: Readonly<Record<string, string>> = {
  'unit/main': `const config = provide(container, 'config', () => ({ port: 3000 }))

await start(container)
const { config: settings } = await resolve(container, { config })`,

  'dependency/main': `provide(container, 'server', {
  dependsOn: { config: 'config' },
  build: ({ dependsOn }) => createServer(dependsOn.config),
})

provide(container, 'config', () => ({ port: 3000 }))`,

  'lifecycle/main': `provide(container, 'server', {
  dependsOn: { config: 'config' },
  build: ({ dependsOn, on }) => {
    const app = createServer(dependsOn.config)
    on('start', () => app.listen())
    on('stop', () => app.close())
    return app
  },
})

await start(container)
await stop(container)`,

  'swap/withdraw': `await tts.withdraw()
provide(container, 'tts', () => createTtsV2())`,
  'swap/replace': `await tts.replace(() => createTtsV2())`,
  'swap/handler': `// In the build of speech
on('dependency-change', ({ dependsOn, decide }) => {
  speech.setTts(dependsOn.tts.value)
  return decide.handled()
})

await tts.replace(() => createTtsV2())`,

  'status/unavailable': `build: ({ setStatus }) => {
  const client = connect()
  client.on('reconnecting', () => setStatus('unavailable'))
  client.on('ready', () => setStatus('ready'))
  return client
}`,
  'status/degraded': `setStatus('degraded', { reason: 'fallback model' })
setStatus('ready')`,
  'status/withdraw': `await llm.withdraw()`,

  'late/required': `const remoteTts = defineKey<Tts>('remote-tts')
provide(container, 'speech', { dependsOn: { tts: remoteTts }, build })

// Later, in the plugin
provide(plugin, remoteTts, () => createRemoteTts())`,
  'late/optional': `provide(container, 'speech', {
  dependsOn: { tts: optional(remoteTts) },
  build: ({ dependsOn }) => createSpeech(dependsOn.tts?.value),
})`,
  'late/first': `provide(container, 'speech', {
  dependsOn: { tts: firstAvailable(remoteTts, localTts) },
  build,
})`,

  'retry/fail': `on('start', async ({ decide }) => {
  try {
    await device.connect()
  }
  catch (error) {
    return decide.fail(error)
  }
})`,
  'retry/requeue': `on('start', async ({ decide }) => {
  try {
    await device.connect()
  }
  catch (error) {
    return decide.requeue({ after: 1_000 })
  }
})`,
  'retry/max-attempts': `on('start', async ({ decide }) => {
  try {
    await device.connect()
  }
  catch (error) {
    return decide.requeue({ after: 1_000, maxAttempts: 2 })
  }
})`,

  'plugin/provide': `provide(container, memoryKey, () => createMemory())
provide(container, agentKey, {
  dependsOn: { memory: memoryKey, llm },
  build,
})`,
  'plugin/commit': `const tx = transaction(container)
tx.provide(memoryKey, () => createMemory())
tx.provide(agentKey, { dependsOn: { memory: memoryKey, llm }, build })
await tx.commit()`,
  'plugin/rollback': `const tx = transaction(container)
tx.provide(memoryKey, () => createMemory())
tx.provide(agentKey, { dependsOn: { memory: memoryKey, llm }, build })
await tx.commit() // rejects: the build of agent failed`,

  'containers/shadow': `const plugin = createContainer({ parent: host })
provide(plugin, 'view', { dependsOn: { theme: 'theme' }, build })

const own = provide(plugin, 'theme', () => createPluginTheme())
await own.withdraw()`,
  'containers/isolate': `const plugin = createContainer({ parent: host, isolate: ['theme'] })
provide(plugin, 'view', { dependsOn: { theme: 'theme' }, build })
provide(plugin, 'theme', () => createPluginTheme())`,
  'containers/exclusive': `const themeKey = defineKey<Theme>('theme', { exclusive: true })
provide(host, themeKey, () => createTheme())
provide(plugin, themeKey, () => createPluginTheme())`,

  'cancel/main': `provide(container, 'app', { dependsOn: { llm: 'llm' }, build })

await start(container, { signal: timeout(container, 5_000) })
// rejects with StartTimeoutError after 5 s`,

  // Getting started, the same as in the README.
  'start/main': `import { injeca } from 'injeca'

const config = injeca.provide('config', () => ({ name: 'injeca' }))

const greeter = injeca.provide('greeter', {
  dependsOn: { config },
  build: ({ dependsOn }) => {
    return (who: string) => \`Hello \${who}, from \${dependsOn.config.name}\`
  },
})

await injeca.start()

const { greeter: greet } = await injeca.resolve({ greeter })
console.info(greet('world')) // Hello world, from injeca

await injeca.stop()`,

  // The cheat sheet, by card id in cheat.ts.
  'cheat/provide': `const config = provide(container, 'config', () => ({ port: 3000 }))`,
  'cheat/depends-on': `provide(container, 'server', {
  dependsOn: { config },
  build: ({ dependsOn }) => createServer(dependsOn.config),
})`,
  'cheat/resolve': `const { config } = await resolve(container, { config })`,
  'cheat/invoke': `invoke(container, {
  dependsOn: { server },
  callback: ({ server }) => console.info(server.address()),
})`,
  'cheat/hooks': `build: ({ on }) => {
  const app = createServer()
  on('start', () => app.listen(3000))
  on('stop', () => app.close())
  return app
}`,
  'cheat/requeue': `on('start', async ({ decide }) => {
  if (!await device.connect())
    return decide.requeue({ after: 1_000, maxAttempts: 5 })
})`,
  'cheat/timeouts': `provide(container, 'camera', {
  timeouts: { start: 10_000 },
  onTimeout: ({ decide }) => decide.requeue({ after: 1_000 }),
  build: () => createCamera(),
})`,
  'cheat/replace': `const tts = provide(container, 'tts', () => createTts())
await tts.replace(() => createTtsV2())`,
  'cheat/withdraw': `await tts.withdraw()`,
  'cheat/dependency-change': `on('dependency-change', ({ dependsOn, decide }) => {
  speech.setTts(dependsOn.tts.value)
  return decide.handled()
})`,
  'cheat/set-status': `client.on('reconnecting', () => setStatus('unavailable'))
client.on('ready', () => setStatus('ready'))`,
  'cheat/define-key': `export const llmKey = defineKey<LlmClient>('airi.llm')`,
  'cheat/optional': `dependsOn: { tts: optional(ttsKey) } // { value, status } | undefined`,
  'cheat/first-available': `dependsOn: { llm: firstAvailable(remoteLlmKey, localLlmKey) }`,
  'cheat/where': `dependsOn: {
  panel: where(panelKey, ({ metadata }) => metadata.version === '2'),
}`,
  'cheat/transaction': `const tx = transaction(container)
tx.provide(memoryKey, () => createMemory())
tx.provide(agentKey, { dependsOn: { memory: memoryKey }, build })
await tx.commit()`,
  'cheat/container': `const plugin = createContainer({ parent: host, owner: { kind: 'plugin', id: 'a' } })
await start(plugin)
await dispose(plugin)`,
  'cheat/isolate': `createContainer({ parent: host, isolate: [themeKey] })`,
  'cheat/exclusive': `const whiteboardKey = defineKey<Whiteboard>('whiteboard', { exclusive: true })`,
  'cheat/visibility': `provide(pluginA, memoryKitKey, { visibility: 'parent', build: () => createMemoryKit() })`,
  'cheat/instances': `provide(container, 'client', {
  instances: 'per-container',
  build: ({ consumer }) => createClient(consumer),
})`,
  'cheat/timeout': `await start(container, { signal: timeout(container, 10_000) })`,
  'cheat/watch': `watch(container, server, ({ phase, status }) => {})
await waitFor(container, server, { status: 'ready' })`,
  'cheat/observe': `observe(container, record => console.info(record.type, record.key))`,
  'cheat/graph': `graph(container).explain(server)
graph(container).impact({ kind: 'withdraw', key: llmKey })`,
  'cheat/manual-clock': `const { clock, advance } = manualClock()
const container = createContainer({ clock })
advance(1_000)`,
}
