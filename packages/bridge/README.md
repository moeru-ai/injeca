# @injeca/bridge

Connects an eventa channel to an injeca child container. A plugin in another process or language uses it to provide units to injeca and to depend on injeca units.

## Status

This package is a placeholder. Step 6 of [the injeca 0.3 design](../../docs/ai/references/2026-11-05-design-0.3.md#remote-plugins) implements it, after injeca 0.3.0. The package is private until then.

## Related packages

Transport packages that open a channel and report its state as an injeca unit use the name `@injeca/channel-<transport>`, for example `@injeca/channel-websocket`.
