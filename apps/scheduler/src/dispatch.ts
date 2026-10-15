/** Process durable outbox entries independently so one failed dispatch cannot starve others. */
export async function dispatchIndependently<T>(
  entries: readonly T[],
  dispatch: (entry: T) => Promise<void>,
  reportFailure: (entry: T, error: unknown) => void,
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      await dispatch(entry);
      succeeded++;
    } catch (error) {
      failed++;
      try {
        reportFailure(entry, error);
      } catch {
        // Diagnostics are best effort. Never let a broken logger starve
        // unrelated durable outbox entries in the same scheduler tick.
      }
    }
  }
  return { succeeded, failed };
}
