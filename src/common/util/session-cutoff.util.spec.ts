import { nextWholeSecond } from './session-cutoff.util';

describe('nextWholeSecond', () => {
  it('advances a sub-second instant to the following whole second', () => {
    // The case the function exists for: a change at 10.400s must not leave a
    // token whose `iat` is 10 looking newer than the change.
    expect(nextWholeSecond(new Date(10_400)).getTime()).toBe(11_000);
  });

  it('leaves an already-whole second alone', () => {
    // Not merely tidy — advancing here would invalidate a token minted in the
    // second AFTER the change, which is a live session nobody asked to end.
    expect(nextWholeSecond(new Date(11_000)).getTime()).toBe(11_000);
  });

  it('never returns an instant earlier than the one it was given', () => {
    const samples = [0, 1, 999, 1_000, 1_001, 1_756_000_123_456];
    for (const milliseconds of samples) {
      const source = new Date(milliseconds);
      expect(nextWholeSecond(source).getTime()).toBeGreaterThanOrEqual(
        source.getTime(),
      );
    }
  });

  it('produces a cutoff that rejects the same second and admits the next', () => {
    // Restates the reader's comparison (`iat < floor(cutoff / 1000)`) so the
    // contract is asserted end to end rather than inferred from arithmetic.
    const changedAt = new Date(20_400);
    const cutoffSeconds = Math.floor(
      nextWholeSecond(changedAt).getTime() / 1000,
    );

    const tokenMintedSameSecond = Math.floor(20_100 / 1000);
    const tokenMintedAfterwards = Math.floor(21_200 / 1000);

    expect(tokenMintedSameSecond < cutoffSeconds).toBe(true);
    expect(tokenMintedAfterwards < cutoffSeconds).toBe(false);
  });
});
