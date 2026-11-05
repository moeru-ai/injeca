# injeca

Pure functional dependency injection for TypeScript, without classes, inspired by uber/fx in Go.

| Package | Description |
| --- | --- |
| [`injeca`](./packages/injeca) | The container: services, lifecycle hooks, run-time changes, and status propagation |
| [`@injeca/bridge`](./packages/bridge) | Connects an eventa channel to a child container, for plugins in other processes and languages. Not published yet. |

See [the 0.3 design](./docs/design-0.3.md).
