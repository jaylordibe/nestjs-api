/**
 * A deterministic race harness.
 *
 * `Promise.all([a, b])` does not test a race, it tests whichever interleaving
 * the event loop happened to pick — so it passes on a fixed bug, passes on the
 * bug, and passes on a machine with a different core count. Every concurrency
 * assertion in this suite that matters is driven from here instead.
 *
 * ## How it works
 *
 * {@link pauseBefore} wraps a real method on a live singleton (`app.get(...)`)
 * so the FIRST call blocks before delegating, and hands back a handle the spec
 * uses to say when it may continue. Everything else about the request is the
 * production code path — no stubbed service, no fake transaction.
 *
 * ## Where to pause
 *
 * **Before a lock is acquired, never while one is held.** That is the entire
 * discipline. Pausing after `SELECT … FOR UPDATE` parks the racing request on a
 * Postgres row lock and the test deadlocks until the pool times out. Pausing
 * *before* it reproduces the actual hazard: the paused request has already read
 * the rows it is about to act on, the other request commits and changes them,
 * and the paused request then has to notice. A revalidation that only re-reads
 * inside the lock is exactly what makes it notice.
 *
 * So the seams are the entry points that take the first lock —
 * `RefreshTokenService.issueForNewSession`,
 * `BusinessOwnershipPolicy.assertUserMayHoldActiveMembership` — and a spec
 * pausing anywhere else should say why.
 */

/** A paused call, and the switch that lets it proceed. */
export interface Pause {
  /** Resolves once the wrapped method has been reached and is waiting. */
  readonly reached: Promise<void>;
  /** Lets the paused call continue into the real implementation. */
  release(): void;
  /** Restores the original method. Safe to call more than once. */
  restore(): void;
}

/**
 * Blocks the first call to `target[method]` until {@link Pause.release}.
 *
 * Later calls run untouched, so the racing request — which usually goes through
 * the same method — is never held up by the pause meant for the first one.
 *
 * Always `restore()` in a `finally` or `afterEach`: the target is the
 * application's real singleton, and a spec that leaves it wrapped corrupts every
 * spec after it in the same file.
 */
export function pauseBefore<Target extends object>(
  target: Target,
  method: keyof Target & string,
): Pause {
  const original = target[method];
  if (typeof original !== 'function') {
    throw new TypeError(`${String(method)} is not a method on the target`);
  }

  let announceReached: () => void;
  const reached = new Promise<void>((resolve) => {
    announceReached = resolve;
  });
  let openGate: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  let isFirstCall = true;
  const wrapped = async function pausedOnce(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    if (isFirstCall) {
      isFirstCall = false;
      announceReached();
      await gate;
    }
    return (original as (...callArgs: unknown[]) => unknown).apply(this, args);
  };

  (target as Record<string, unknown>)[method] = wrapped;

  return {
    reached,
    release: () => openGate(),
    restore: () => {
      (target as Record<string, unknown>)[method] = original;
    },
  };
}

/**
 * Blocks the first call to `target[method]` AFTER it has run, before returning.
 *
 * The counterpart to {@link pauseBefore}, for the other kind of gap: not "what
 * this request read is now stale", but "this request has already committed
 * something, and the rest of its work has not happened yet". Pausing here is
 * safe for the same reason pausing before a lock is — the transaction inside the
 * wrapped method has closed, so nothing is held while the racer runs.
 *
 * The case it exists for is session issuance: the refresh row commits inside the
 * method, and the access token is signed by the caller afterwards. A revocation
 * landing between those two is invisible to a `pauseBefore` test, because that
 * one releases before either has happened.
 */
export function pauseAfter<Target extends object>(
  target: Target,
  method: keyof Target & string,
): Pause {
  const original = target[method];
  if (typeof original !== 'function') {
    throw new TypeError(`${String(method)} is not a method on the target`);
  }

  let announceReached: () => void;
  const reached = new Promise<void>((resolve) => {
    announceReached = resolve;
  });
  let openGate: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  let isFirstCall = true;
  const wrapped = async function pausedOnce(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    const result = await (
      original as (...callArgs: unknown[]) => Promise<unknown>
    ).apply(this, args);
    if (isFirstCall) {
      isFirstCall = false;
      announceReached();
      await gate;
    }
    return result;
  };

  (target as Record<string, unknown>)[method] = wrapped;

  return {
    reached,
    release: () => openGate(),
    restore: () => {
      (target as Record<string, unknown>)[method] = original;
    },
  };
}

/**
 * Runs `racer` while `pausedRequest` is held at its seam, then releases it.
 *
 * The shape every race test wants: start the request that will be interrupted,
 * wait until it is provably parked, run the request that interrupts it **to
 * completion**, then let the first one resume and see what it does. There is no
 * timing assumption anywhere in that sequence.
 *
 * Returns both outcomes as settled results, because in most of these races one
 * side is SUPPOSED to fail and the assertion is about which one.
 *
 * **`pausedRequest` is subscribed to before anything else, and that line is
 * load-bearing.** A supertest `Test` is a lazy thenable: it does not send
 * anything until something calls `.then` on it. Awaiting `paused.reached` first
 * would therefore wait for a request that has not been issued, and the test
 * would hang until Jest's timeout rather than fail with a useful message.
 */
export async function runRace<Paused, Racer>(
  pausedRequest: PromiseLike<Paused>,
  paused: Pause,
  racer: () => Promise<Racer>,
): Promise<{
  paused: PromiseSettledResult<Paused>;
  racer: PromiseSettledResult<Racer>;
}> {
  // Subscribing is what SENDS a supertest request. Must come first.
  const pausedSettled = Promise.allSettled([pausedRequest]);
  try {
    await paused.reached;
    const [racerResult] = await Promise.allSettled([racer()]);
    paused.release();
    const [pausedResult] = await pausedSettled;
    return { paused: pausedResult, racer: racerResult };
  } finally {
    paused.restore();
  }
}
