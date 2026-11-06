# @injeca/docs

The scenario lab of injeca: a page that runs the real container step by step, so each frame shows what a primitive does to a graph.

- `src/lab`: each chapter drives injeca on a manual clock and records its frames. `lab.test.ts` keeps them in snapshots.
- `src/components`, `src/stage`: the page, the player of each chapter, the sandbox, and the cheat sheet.
- `src/hero`: the three.js scene of the first screen.
- `src/locales`: English and Simplified Chinese, as YAML. `content.yaml` holds the translated teaching text by path.
- `scripts/banners.ts`: renders the README figures to `docs/assets/banners`.

The page imports the source of `packages/injeca`, so it always shows the current behavior.

```sh
pnpm -F @injeca/docs dev       # the lab
pnpm -F @injeca/docs build     # dist/
pnpm -F @injeca/docs banners   # the README figures, with headless Chrome
```

`wrangler.toml` deploys `dist/` to Cloudflare Workers as an assets-only Worker. `.github/workflows/deploy-cloudflare-workers.yml` deploys `main`, and the two preview workflows upload a preview for each pull request after a maintainer approves it.
