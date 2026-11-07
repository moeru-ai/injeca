// Copies the repository README to the README of the injeca package, so npm shows the same guide.
// Run it through `pnpm docs:update` after a change of README.md.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const repository = 'https://github.com/moeru-ai/injeca/blob/main'
const raw = 'https://raw.githubusercontent.com/moeru-ai/injeca/main'

const readme = readFileSync(join(root, 'README.md'), 'utf8')
// A relative link of the repository README breaks in the package and on npm, so it points to GitHub instead.
const synced = readme
  .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_match, path: string) => `](${repository}/${path.replace(/^\.\//, '')})`)
  // Images in HTML, such as the banners in <picture>, need the raw file: a GitHub page is not an image.
  .replace(/\b(src|srcset)="(?!https?:|#|data:)([^"]+)"/g, (_match, attribute: string, path: string) => `${attribute}="${raw}/${path.replace(/^\.\//, '')}"`)

writeFileSync(join(root, 'packages', 'injeca', 'README.md'), `<!-- Generated from README.md of the repository by \`pnpm docs:update\`. Edit README.md instead. -->\n\n${synced}`)
