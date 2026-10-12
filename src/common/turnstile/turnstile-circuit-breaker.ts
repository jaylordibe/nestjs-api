// Circuit breaker around the Cloudflare siteverify call.
//
// The Turnstile check fails closed: when Cloudflare cannot be asked, the request
// is refused. That is the right default for a bot check, but on its own it ties
// sign-in, sign-up and every texted code to a third party's uptime. This breaker
// is the one lever: after a few consecutive NO-ANSWERS it lets token-bearing
// requests through unverified for a short window, each one audited by
// TurnstileService.
//
// A no-answer means Cloudflare never rendered a verdict:
//   - the call threw (unreachable, DNS, TLS, our timeout);
//   - siteverify answered 5xx, or `internal-error` (its own fault);
//   - a 2xx body could not be read as a siteverify answer.
//
// It deliberately never trips on, and is reset by:
//   - a refused token — that IS a verdict; keep refusing;
//   - Cloudflare saying OUR request is wrong (a 4xx, or an error code about the
//     secret). Bypassing on that would let a mistyped secret switch the check
//     off for good. Those keep failing closed, loudly.
//
// Recovery needs no operator: once the window elapses the next request asks
// Cloudflare for real (half-open). Any verdict closes the breaker; another
// no-answer re-opens it for a further window.
//
// In memory, per process — correct while each environment runs one API process
// (docs/prod/docker-compose.yml, docs/staging/docker-compose.yml). With several
// replicas each would trip and recover on its own; revisit when the API runs
// more than one.

// Consecutive no-answers before the bypass engages. More than one, so a single
// blip cannot switch the check off; few enough that an outage costs only a
// handful of refused requests.
export const PROVIDER_FAILURE_THRESHOLD = 3;

// How long the bypass stays engaged before a request asks Cloudflare again.
// Short, because it bounds how long checks are skipped after Cloudflare is back.
export const OPEN_WINDOW_MILLISECONDS = 30_000;

// No-answers further apart than this are not "consecutive": the count starts
// over, so a blip hours after an old episode cannot engage the bypass on its
// own. Measured from the last failure or the end of the open window, whichever
// is later — bypassed requests record nothing, so a probe on a quiet service
// must still extend a live outage rather than start a new one.
export const FAILURE_MEMORY_MILLISECONDS = 2 * OPEN_WINDOW_MILLISECONDS;

export interface ProviderFailureOutcome {
  // Requests may now skip verification.
  readonly isBypassActive: boolean;
  // This failure opened the breaker — announce the episode once, not on every
  // bypassed request.
  readonly hasJustOpened: boolean;
}

export class TurnstileCircuitBreaker {
  private consecutiveProviderFailures = 0;
  private lastFailureMilliseconds: number | null = null;
  private openUntilMilliseconds: number | null = null;

  // True while the open window runs. Once it elapses this is false again, so the
  // next request goes through to Cloudflare — the half-open probe — with no timer.
  shouldBypass(nowMilliseconds: number): boolean {
    return (
      this.openUntilMilliseconds !== null &&
      nowMilliseconds < this.openUntilMilliseconds
    );
  }

  recordProviderFailure(nowMilliseconds: number): ProviderFailureOutcome {
    if (this.lastFailureMilliseconds !== null) {
      const lastEvidenceMilliseconds = Math.max(
        this.lastFailureMilliseconds,
        this.openUntilMilliseconds ?? 0,
      );
      if (
        nowMilliseconds - lastEvidenceMilliseconds >
        FAILURE_MEMORY_MILLISECONDS
      ) {
        this.recordProviderSuccess();
      }
    }
    this.lastFailureMilliseconds = nowMilliseconds;
    this.consecutiveProviderFailures += 1;

    if (this.consecutiveProviderFailures < PROVIDER_FAILURE_THRESHOLD) {
      return { isBypassActive: false, hasJustOpened: false };
    }

    this.openUntilMilliseconds = nowMilliseconds + OPEN_WINDOW_MILLISECONDS;
    return {
      isBypassActive: true,
      // Exactly at the threshold starts an episode. A failed half-open probe
      // re-opens the breaker but keeps counting up, so a long outage announces
      // once; `recordProviderSuccess` resets the count for the next episode.
      hasJustOpened:
        this.consecutiveProviderFailures === PROVIDER_FAILURE_THRESHOLD,
    };
  }

  // Cloudflare answered — any verdict, a refused token included, or a reply
  // saying our own request is wrong — so it is reachable. Returns true only when this closes an open breaker,
  // so recovery is logged once.
  recordProviderSuccess(): boolean {
    const wasOpen = this.openUntilMilliseconds !== null;
    this.consecutiveProviderFailures = 0;
    this.lastFailureMilliseconds = null;
    this.openUntilMilliseconds = null;
    return wasOpen;
  }
}
