import { TimeScope } from '../enums/time-scope.enum';
import {
  buildDateRangeFilter,
  buildTimeScopeFilter,
  startOfTodayUtc,
} from './date-range.util';

describe('buildDateRangeFilter', () => {
  const START = '2026-07-01T00:00:00.000Z';
  const END = '2026-07-31T23:59:59.999Z';

  // The contract the callers depend on: no bounds means "don't filter at all",
  // NOT "filter on an empty object". A `{}` would still be spread into `where`
  // and read as a filter that is present but matches everything.
  it('returns undefined when neither bound is supplied', () => {
    expect(buildDateRangeFilter({})).toBeUndefined();
    expect(
      buildDateRangeFilter({ start: undefined, end: undefined }),
    ).toBeUndefined();
  });

  it('builds an inclusive range on both ends', () => {
    expect(buildDateRangeFilter({ start: START, end: END })).toEqual({
      gte: new Date(START),
      lte: new Date(END),
    });
  });

  it('supports an open-ended range in either direction', () => {
    expect(buildDateRangeFilter({ start: START })).toEqual({
      gte: new Date(START),
    });
    expect(buildDateRangeFilter({ end: END })).toEqual({ lte: new Date(END) });
  });

  it('accepts an already-parsed Date without round-tripping it', () => {
    const start = new Date(START);
    expect(buildDateRangeFilter({ start })).toEqual({ gte: start });
  });

  // An empty string is what an omitted query param collapses to on some
  // clients; treating it as a bound would yield `new Date('')` → Invalid Date,
  // which Prisma rejects at query time with a message naming neither the field
  // nor the endpoint.
  it('ignores an empty string rather than producing an Invalid Date', () => {
    expect(buildDateRangeFilter({ start: '', end: '' })).toBeUndefined();
  });
});

describe('buildTimeScopeFilter', () => {
  const NOW = new Date('2026-07-15T12:00:00.000Z');
  const LAST_WEEK = new Date('2026-07-08T12:00:00.000Z');
  const NEXT_WEEK = new Date('2026-07-22T12:00:00.000Z');

  it('applies the range alone for ALL or no scope', () => {
    expect(
      buildTimeScopeFilter({ start: LAST_WEEK, end: NEXT_WEEK, now: NOW }),
    ).toEqual({ gte: LAST_WEEK, lte: NEXT_WEEK });
    expect(
      buildTimeScopeFilter({
        start: LAST_WEEK,
        scope: TimeScope.ALL,
        now: NOW,
      }),
    ).toEqual({ gte: LAST_WEEK });
    expect(
      buildTimeScopeFilter({ scope: TimeScope.ALL, now: NOW }),
    ).toBeUndefined();
  });

  it('floors UPCOMING at now, and PAST strictly below it', () => {
    expect(
      buildTimeScopeFilter({ scope: TimeScope.UPCOMING, now: NOW }),
    ).toEqual({ gte: NOW });
    expect(buildTimeScopeFilter({ scope: TimeScope.PAST, now: NOW })).toEqual({
      lt: NOW,
    });
  });

  // The composition rule: whichever bound is tighter wins, so a scope and a
  // range can never contradict each other into an empty-but-silent result.
  describe('more restrictive bound wins', () => {
    it('UPCOMING lifts a start that is in the past', () => {
      expect(
        buildTimeScopeFilter({
          start: LAST_WEEK,
          scope: TimeScope.UPCOMING,
          now: NOW,
        }),
      ).toEqual({ gte: NOW });
    });

    it('UPCOMING keeps a start that is already later than now', () => {
      expect(
        buildTimeScopeFilter({
          start: NEXT_WEEK,
          scope: TimeScope.UPCOMING,
          now: NOW,
        }),
      ).toEqual({ gte: NEXT_WEEK });
    });

    it('PAST caps an end that runs beyond now', () => {
      expect(
        buildTimeScopeFilter({
          end: NEXT_WEEK,
          scope: TimeScope.PAST,
          now: NOW,
        }),
      ).toEqual({ lt: NOW });
    });

    it('PAST keeps an end that is already tighter, and stays inclusive there', () => {
      expect(
        buildTimeScopeFilter({
          end: LAST_WEEK,
          scope: TimeScope.PAST,
          now: NOW,
        }),
      ).toEqual({ lte: LAST_WEEK });
    });
  });

  // `lt` rather than `lte` at the boundary: an instant exactly at `now` must
  // land in exactly one scope, or a row shows up in both lists.
  it('never counts the boundary instant in both scopes', () => {
    const past = buildTimeScopeFilter({ scope: TimeScope.PAST, now: NOW });
    const upcoming = buildTimeScopeFilter({
      scope: TimeScope.UPCOMING,
      now: NOW,
    });
    expect(past).toHaveProperty('lt', NOW);
    expect(past).not.toHaveProperty('lte');
    expect(upcoming).toHaveProperty('gte', NOW);
  });

  it('leaves the opposite bound untouched', () => {
    expect(
      buildTimeScopeFilter({
        end: NEXT_WEEK,
        scope: TimeScope.UPCOMING,
        now: NOW,
      }),
    ).toEqual({ gte: NOW, lte: NEXT_WEEK });
    expect(
      buildTimeScopeFilter({
        start: LAST_WEEK,
        scope: TimeScope.PAST,
        now: NOW,
      }),
    ).toEqual({ gte: LAST_WEEK, lt: NOW });
  });
});

describe('startOfTodayUtc', () => {
  // The reason it exists: with a full-precision `now`, a @db.Date row dated
  // today falls out of `upcoming` the instant the clock passes midnight UTC.
  it('returns midnight UTC today', () => {
    const startOfToday = startOfTodayUtc();
    expect(startOfToday.getUTCHours()).toBe(0);
    expect(startOfToday.getUTCMinutes()).toBe(0);
    expect(startOfToday.getUTCSeconds()).toBe(0);
    expect(startOfToday.getUTCMilliseconds()).toBe(0);
    expect(startOfToday.toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10),
    );
  });
});
