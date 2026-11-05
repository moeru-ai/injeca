import type { OwnerRecord } from './service'

/** The identity of an event. Any object with a string `id` is an event key, for example an eventa definition. */
export interface EventKey {
  readonly id: string
}

/** A frozen record on a listener, for example its priority, timeout, or failure policy. injeca does not read it. */
export type ListenerMetadata = Readonly<Record<string, unknown>>

/** One listener that `listeners()` returns. */
export interface ListenerEntry<H> {
  readonly handler: H
  /** The owner record of the container that owns the listener. */
  readonly owner: OwnerRecord
  readonly metadata: ListenerMetadata
}
