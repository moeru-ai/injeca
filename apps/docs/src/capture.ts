// The sizes of the README banners. The page renders each scene at its size, and scripts/banners.ts screenshots it.
// Each banner is about 2.8:1, so it sits in a README section like a figure.
// The file has no imports, so the banner script can read it in Node. lab.test.ts checks that the ids match the scenarios.

/** The chapters with more than one variant. Each has a comparison figure in the README, in the order of src/lab/scenarios.ts. */
export const COMPARED = ['swap', 'status', 'late', 'retry', 'plugin', 'containers'] as const

export const CAPTURE_SIZES: Readonly<Record<string, { readonly width: number, readonly height: number }>> = {
  hero: { width: 1440, height: 600 },
  // The Open Graph image of the page: the hero at the size that link previews use.
  og: { width: 1200, height: 630 },
  features: { width: 1440, height: 700 },
  phases: { width: 1440, height: 480 },
  ...Object.fromEntries(COMPARED.map(id => [`compare-${id}`, { width: 1440, height: 480 }])),
}
