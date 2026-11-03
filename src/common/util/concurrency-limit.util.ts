// Runs at most `limit` tasks at once; later calls wait their turn, in order.
//
// For work whose cost is set by something other than the request's size —
// decoding an image costs its PIXEL count in native memory, outside the V8
// heap — so that a burst of small requests cannot multiply that cost past what
// the process can hold.
export type ConcurrencyLimit = <T>(task: () => Promise<T>) => Promise<T>;

export function createConcurrencyLimit(limit: number): ConcurrencyLimit {
  let running = 0;
  const waiting: Array<() => void> = [];

  const release = (): void => {
    running -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
