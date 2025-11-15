# Injeca

Pure functional programming (means no `class` and extra wrappers and containers) based dependency injection with application lifecycle management.

> Heavily inspired by [uber/fig](https://go.uber.org/fig) and [uber/dig](https://go.uber.org/dig) in Golang ecosystem.

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

## Installation

```sh
npm install injeca
pnpm add injeca
bun add injeca
ni injeca
yarn add injeca
```

## Basic usage

`injeca` ships with a global singleton container exposed as `injeca`. You can register
providers, declare their dependencies, and run invocations once everything is ready.

```ts
import { createServer } from 'node:http'

import { injeca, lifecycle } from 'injeca'

// Providers return a value once and are cached inside the container.
const config = injeca.provide('config', () => ({ port: 3000 }))

const server = injeca.provide({
  dependsOn: { config, lifecycle },
  async build({ dependsOn }) {
    const { config, lifecycle } = dependsOn
    const app = createServer()

    lifecycle.appHooks.onStart(() => app.listen(config.port))
    lifecycle.appHooks.onStop(() => app.close())

    return app
  },
})

injeca.invoke({
  dependsOn: { server },
  async callback({ server }) {
    // eslint-disable-next-line no-console
    console.log('HTTP server ready:', await server.address())
  },
})

await injeca.start()

process.once('SIGINT', async () => {
  await injeca.stop()
})
```

### Manual containers

If you need multiple containers (for tests or per-request scopes), create them
explicitly and pass the container reference into `provide`, `invoke`, `start`, and
`stop`.

```ts
import { createContainer, invoke, provide, start, stop } from 'injeca'

const container = createContainer()

const token = provide(container, 'token', () => crypto.randomUUID())

invoke(container, {
  dependsOn: { token },
  // eslint-disable-next-line no-console
  callback: ({ token }) => console.log('token', token),
})

await start(container)
await stop(container)
```

## License

MIT

[npm-version-src]: https://img.shields.io/npm/v/injeca?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/injeca
[npm-downloads-src]: https://img.shields.io/npm/dm/injeca?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/injeca
[bundle-src]: https://img.shields.io/bundlephobia/minzip/injeca?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=injeca
[license-src]: https://img.shields.io/github/license/moeru-ai/injeca.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/moeru-ai/injeca/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/injeca
