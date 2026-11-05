import { isUndefined, omitBy } from 'es-toolkit'

/** The fields of `T` that are not `undefined`, each one optional. */
export type DefinedFields<T> = { [K in keyof T]?: Exclude<T[K], undefined> }

/** Copies `fields` without the fields that are `undefined`. Spread the result to add optional fields to a record. */
export function withoutUndefined<T extends Record<string, unknown>>(fields: T): DefinedFields<T> {
  return omitBy(fields, isUndefined) as DefinedFields<T>
}
