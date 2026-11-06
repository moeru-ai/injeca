import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getContainer, invoke, provide, resetContainer, start, stop } from './global'
import { createContainer, resolve as resolveIn } from './scoped'

beforeEach(() => {
  resetContainer()
})

// The 0.2 workflow cases used the removed `lifecycle` key. These cases port them to `on('start')` and `on('stop')`.

interface Database {
  connect: () => Promise<void>
  close: () => Promise<void>
}

interface WebSocketServer {
  start: () => Promise<void>
  stop: () => Promise<void>
}

function createSpies() {
  return {
    databaseConnect: vi.fn(),
    databaseClose: vi.fn(),
    webSocketServerStart: vi.fn(),
    webSocketServerStop: vi.fn(),
  }
}

function expectEachCalledOnce(spies: ReturnType<typeof createSpies>) {
  expect(spies.databaseConnect).toHaveBeenCalledTimes(1)
  expect(spies.databaseClose).toHaveBeenCalledTimes(1)
  expect(spies.webSocketServerStart).toHaveBeenCalledTimes(1)
  expect(spies.webSocketServerStop).toHaveBeenCalledTimes(1)
}

describe('workflow with named and on hooks', () => {
  it('should work with named pattern', async () => {
    const spies = createSpies()

    provide('db', {
      build: ({ on }) => {
        const database: Database = { connect: spies.databaseConnect, close: spies.databaseClose }
        on('stop', async () => await database.close())
        return database
      },
    })

    provide<{ database: Database }>('ws', {
      dependsOn: { database: 'db' },
      build: async ({ dependsOn, on }) => {
        await dependsOn.database.connect()
        const server: WebSocketServer = { start: spies.webSocketServerStart, stop: spies.webSocketServerStop }
        on('stop', async () => await server.stop())
        return server
      },
    })

    invoke<{ webSocketServer: WebSocketServer }>({
      dependsOn: { webSocketServer: 'ws' },
      callback: async ({ webSocketServer }) => await webSocketServer.start(),
    })

    await start()
    await stop()

    expectEachCalledOnce(spies)
  })
})

describe('workflow with typed and on hooks', () => {
  it('should work with typed named pattern', async () => {
    const spies = createSpies()

    const database = provide('db', {
      build: ({ on }) => {
        const database: Database = { connect: spies.databaseConnect, close: spies.databaseClose }
        on('stop', async () => await database.close())
        return database
      },
    })

    const webSocketServer = provide('ws', {
      dependsOn: { database },
      build: async ({ dependsOn, on }) => {
        await dependsOn.database.connect()
        const server: WebSocketServer = { start: spies.webSocketServerStart, stop: spies.webSocketServerStop }
        on('start', async () => await server.start())
        on('stop', async () => await server.stop())
        return server
      },
    })

    invoke({
      dependsOn: { webSocketServer },
      callback: () => {},
    })

    await start()
    await stop()

    expectEachCalledOnce(spies)
  })
})

describe('workflow with auto name and on hooks', () => {
  it('should work with auto name pattern', async () => {
    const spies = createSpies()

    const database = provide({
      build: ({ on }) => {
        const database: Database = { connect: spies.databaseConnect, close: spies.databaseClose }
        on('stop', async () => await database.close())
        return database
      },
    })

    const webSocketServer = provide({
      dependsOn: { database },
      build: async ({ dependsOn, on }) => {
        await dependsOn.database.connect()
        const server: WebSocketServer = { start: spies.webSocketServerStart, stop: spies.webSocketServerStop }
        on('stop', async () => await server.stop())
        return server
      },
    })

    invoke({
      dependsOn: { webSocketServer },
      callback: async ({ webSocketServer }) => await webSocketServer.start(),
    })

    await start()
    await stop()

    expectEachCalledOnce(spies)
    expect(database.key).toMatch(/global\.test\.ts:\d+:\d+$/)
    expect(webSocketServer.key).not.toBe(database.key)
  })
})

describe('getContainer', () => {
  it('returns the root container of the global functions, and resetContainer replaces it', async () => {
    const before = getContainer()
    provide('config', () => 'config')
    await expect(resolveIn(before, { config: 'config' })).resolves.toEqual({ config: 'config' })

    const child = createContainer({ parent: before })
    expect(child.parent).toBe(before)

    resetContainer()
    const after = getContainer()
    expect(after).not.toBe(before)
    provide('other', () => 'other')
    await expect(resolveIn(after, { other: 'other' })).resolves.toEqual({ other: 'other' })
  })
})
