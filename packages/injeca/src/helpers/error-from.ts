/**
 * Makes one error from collected errors. One error keeps its identity. More than one error becomes an `AggregateError`.
 *
 * The result is `unknown`, because a thrown value is not always an `Error`.
 */
export function errorFrom(errors: readonly unknown[], message: string): unknown {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message)
}
