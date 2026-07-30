// Bounds a promise that has no timeout of its own.
//
// The motivating case: a Redis client configured with
// `maxRetriesPerRequest: null` (which BullMQ requires for its blocking reads)
// BUFFERS commands indefinitely while the server is unreachable rather than
// rejecting them. A health check built on such a client would hang open
// instead of failing — the opposite of what a readiness probe is for.
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutTimer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutTimer = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    // Load-bearing: a pending timer keeps the event loop alive, which stalls
    // both a graceful shutdown and jest's teardown long after the operation
    // itself has settled.
    clearTimeout(timeoutTimer);
  }
}
