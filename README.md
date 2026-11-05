# injeca

Pure functional dependency injection for TypeScript. Services declare their dependencies, own their lifecycle, and converge when the graph changes at run time. No classes and no decorators.

```ts
import { injeca } from 'injeca'

const config = injeca.provide('config', () => ({ port: 3000 }))

const server = injeca.provide({
  dependsOn: { config },
  build({ dependsOn, on }) {
    const app = createServer()
    on('start', () => app.listen(dependsOn.config.port))
    on('stop', () => app.close())
    return app
  },
})

await injeca.start()
```

## Packages

| Package | Description | Status |
| --- | --- | --- |
| [`injeca`](./packages/injeca) | The container: services, lifecycle hooks, run-time changes, status propagation, and child containers | Published |
| [`@injeca/bridge`](./packages/bridge) | Connects an eventa channel to a child container, so that plugins in other processes and languages can export and use services | Planned |

Transport packages that open a channel and report it as a service use the name `@injeca/channel-<transport>`, for example `@injeca/channel-websocket`.

## Documentation

- [injeca README](./packages/injeca/README.md): installation, usage, and migration from 0.2
- [The injeca agent skill](./skills/injeca/SKILL.md): `npx skills add moeru-ai/injeca`

## Development

This repository is a pnpm workspace.

```sh
pnpm install
pnpm typecheck
pnpm test:run
pnpm lint
pnpm build
```

## License

[MIT](./LICENSE)
