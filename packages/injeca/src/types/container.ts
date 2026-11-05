import type { Logger, LoggerOptions } from '../diagnostics/logger'
import type { Clock } from '../helpers/clock'
import type { KeyReference } from './keys'
import type { OwnerRecord } from './service'

export interface Container {
  logger: Logger
  readonly owner: OwnerRecord
  readonly parent: Container | undefined
}

export interface ContainerOptions extends LoggerOptions {
  /** Makes a child container. It resolves keys from its own registrations and from those of its ancestors. */
  parent?: Container
  /** A serializable owner record. It defaults to an empty record. */
  owner?: OwnerRecord
  /** The time source. Only a root container reads it. A child container uses the clock of its root. */
  clock?: Clock
  /**
   * The keys that do not resolve from the ancestors. The container and its descendants resolve them only from their own registrations.
   * An isolated key also ends the resolution area of an exclusive key of an ancestor.
   */
  isolate?: readonly KeyReference[]
}
