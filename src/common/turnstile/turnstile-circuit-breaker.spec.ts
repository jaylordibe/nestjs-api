import {
  FAILURE_MEMORY_MILLISECONDS,
  OPEN_WINDOW_MILLISECONDS,
  PROVIDER_FAILURE_THRESHOLD,
  TurnstileCircuitBreaker,
} from './turnstile-circuit-breaker';

describe('TurnstileCircuitBreaker', () => {
  const startMilliseconds = 1_700_000_000_000;

  function recordFailures(
    breaker: TurnstileCircuitBreaker,
    count: number,
    nowMilliseconds = startMilliseconds,
  ): void {
    for (let failureIndex = 0; failureIndex < count; failureIndex += 1) {
      breaker.recordProviderFailure(nowMilliseconds);
    }
  }

  it('starts closed, so every token is verified', () => {
    expect(new TurnstileCircuitBreaker().shouldBypass(startMilliseconds)).toBe(
      false,
    );
  });

  it('does not open before the threshold — one blip cannot skip the check', () => {
    const breaker = new TurnstileCircuitBreaker();

    for (
      let failureIndex = 0;
      failureIndex < PROVIDER_FAILURE_THRESHOLD - 1;
      failureIndex += 1
    ) {
      expect(breaker.recordProviderFailure(startMilliseconds)).toEqual({
        isBypassActive: false,
        hasJustOpened: false,
      });
    }
    expect(breaker.shouldBypass(startMilliseconds)).toBe(false);
  });

  it('opens on the threshold failure and announces it once', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD - 1);

    expect(breaker.recordProviderFailure(startMilliseconds)).toEqual({
      isBypassActive: true,
      hasJustOpened: true,
    });
    expect(breaker.recordProviderFailure(startMilliseconds + 1_000)).toEqual({
      isBypassActive: true,
      hasJustOpened: false,
    });
  });

  it('bypasses for the open window, then lets the next request ask again', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD);

    expect(breaker.shouldBypass(startMilliseconds)).toBe(true);
    expect(
      breaker.shouldBypass(startMilliseconds + OPEN_WINDOW_MILLISECONDS - 1),
    ).toBe(true);
    expect(
      breaker.shouldBypass(startMilliseconds + OPEN_WINDOW_MILLISECONDS),
    ).toBe(false);
  });

  it('closes on a verdict and reports recovery once', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD);

    expect(breaker.recordProviderSuccess()).toBe(true);
    expect(breaker.shouldBypass(startMilliseconds)).toBe(false);
    expect(breaker.recordProviderSuccess()).toBe(false);
  });

  it('resets the count on a verdict, so old failures cannot re-open it', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD);
    breaker.recordProviderSuccess();

    expect(
      breaker.recordProviderFailure(startMilliseconds).isBypassActive,
    ).toBe(false);
  });

  it('extends a live outage when the first probe comes long after the window, on a quiet service', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD);

    const lateProbe =
      startMilliseconds +
      OPEN_WINDOW_MILLISECONDS +
      FAILURE_MEMORY_MILLISECONDS;
    expect(breaker.recordProviderFailure(lateProbe)).toEqual({
      isBypassActive: true,
      hasJustOpened: false,
    });
  });

  it('remembers a no-answer exactly at the memory boundary, and forgets one just past it', () => {
    const kept = new TurnstileCircuitBreaker();
    recordFailures(kept, PROVIDER_FAILURE_THRESHOLD - 1);
    expect(
      kept.recordProviderFailure(
        startMilliseconds + FAILURE_MEMORY_MILLISECONDS,
      ).isBypassActive,
    ).toBe(true);

    const forgotten = new TurnstileCircuitBreaker();
    recordFailures(forgotten, PROVIDER_FAILURE_THRESHOLD - 1);
    expect(
      forgotten.recordProviderFailure(
        startMilliseconds + FAILURE_MEMORY_MILLISECONDS + 1,
      ).isBypassActive,
    ).toBe(false);
  });

  it('forgets no-answers too far apart to be consecutive', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD - 1);

    const muchLater = startMilliseconds + FAILURE_MEMORY_MILLISECONDS + 1;
    expect(breaker.recordProviderFailure(muchLater).isBypassActive).toBe(false);
  });

  it('treats a blip long after an old episode as a fresh start, which announces again', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD);

    const hoursLater = startMilliseconds + 10 * FAILURE_MEMORY_MILLISECONDS;
    expect(breaker.recordProviderFailure(hoursLater).isBypassActive).toBe(
      false,
    );
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD - 2, hoursLater);
    expect(breaker.recordProviderFailure(hoursLater)).toEqual({
      isBypassActive: true,
      hasJustOpened: true,
    });
  });

  it('re-opens for a fresh window when the half-open probe also fails, without re-announcing', () => {
    const breaker = new TurnstileCircuitBreaker();
    recordFailures(breaker, PROVIDER_FAILURE_THRESHOLD);
    const probeMilliseconds = startMilliseconds + OPEN_WINDOW_MILLISECONDS;

    expect(breaker.recordProviderFailure(probeMilliseconds)).toEqual({
      isBypassActive: true,
      hasJustOpened: false,
    });
    expect(
      breaker.shouldBypass(probeMilliseconds + OPEN_WINDOW_MILLISECONDS - 1),
    ).toBe(true);
  });
});
