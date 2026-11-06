declare module 'virtual:highlighted-samples' {
  interface HighlightedToken {
    color?: string
    content: string
    /** Flags: italic 1, bold 2. */
    fontStyle?: number
  }

  /** For each theme, the lines of each sample of src/lab/samples.ts by `<scenario>/<variant>`, each line a list of tokens. */
  const samples: Record<'dark' | 'light', Record<string, HighlightedToken[][]>>
  export default samples
}

declare module 'virtual:icons' {
  /** The SVG body of each icon that vite.config.ts takes, by name, and the side of its square view box. */
  const icons: Record<string, { body: string, size: number }>
  export default icons
}

declare module '*.yaml' {
  const value: Record<string, any>
  export default value
}

declare module 'virtual:cjk-font' {}
