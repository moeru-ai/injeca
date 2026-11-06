/**
 * Makes one error from collected errors. One error keeps its identity. More than one error becomes an `AggregateError`.
 *
 * The result is `unknown`, because a thrown value is not always an `Error`.
 */
export function errorFrom(errors: readonly unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message)
}

/** The message of a thrown value: `message` of an `Error` or a `DOMException`, else `String(value)`. */
export function messageOf(value: unknown): string {
  if (typeof value === 'object' && value !== null && typeof (value as { readonly message?: unknown }).message === 'string')
    return (value as { readonly message: string }).message

  return String(value)
}
