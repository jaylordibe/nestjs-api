import { TimeScope } from '../enums/time-scope.enum';

// An optional inclusive date range as a Prisma date filter, for any
// moment-in-time column.
//
// Both bounds are independently omittable ("everything after X" / "everything
// before X"), and it returns `undefined` when neither is supplied so the caller
// can skip the `where` assignment entirely rather than emit an empty filter
// object that Prisma would still have to reason about.
//
// Accepts `Date` as well as `string`, so a caller already holding a parsed
// value doesn't have to round-trip it through ISO.
export function buildDateRangeFilter(bounds: {
  start?: string | Date;
  end?: string | Date;
}): { gte?: Date; lte?: Date } | undefined {
  const { start, end } = bounds;
  const filter: { gte?: Date; lte?: Date } = {};
  if (start) filter.gte = start instanceof Date ? start : new Date(start);
  if (end) filter.lte = end instanceof Date ? end : new Date(end);
  return Object.keys(filter).length > 0 ? filter : undefined;
}

// Composes an optional inclusive range with an optional `TimeScope` into a
// single Prisma date filter for any moment-in-time column. Returns undefined
// when no bound applies, so the caller can skip the assignment.
//
// When BOTH a user-supplied range and a scope are present, the **more
// restrictive** bound on each side wins, so the result is unambiguous rather
// than a silent contradiction — e.g. `scope=upcoming` with a `start` of last
// week collapses to `{ gte: now }`, because `now` is the later lower bound.
//
// `now` is injected rather than read from the clock so the caller decides the
// reference moment, and so this stays a pure function:
//   - `new Date()` for full-precision timestamp columns.
//   - `startOfTodayUtc()` for `@db.Date` columns, so a row dated today stays
//     in `upcoming` instead of rolling into `past` at midday.
export function buildTimeScopeFilter(bounds: {
  start?: string | Date;
  end?: string | Date;
  scope?: TimeScope;
  now: Date;
}): { gte?: Date; lte?: Date; lt?: Date } | undefined {
  const { scope, now } = bounds;
  const filter: { gte?: Date; lte?: Date; lt?: Date } =
    buildDateRangeFilter(bounds) ?? {};

  if (scope === TimeScope.UPCOMING) {
    // Upper bound untouched; lower bound = max(user gte, now).
    filter.gte = filter.gte && filter.gte > now ? filter.gte : now;
  } else if (scope === TimeScope.PAST) {
    // Lower bound untouched; upper bound = min(user lte, now). Strict `lt`, so
    // the boundary instant is not counted by BOTH scopes. If the user's `lte`
    // is already at or before now it is the more restrictive bound — keep it
    // and skip `lt`.
    if (!filter.lte || filter.lte > now) {
      filter.lt = now;
      delete filter.lte;
    }
  }
  // TimeScope.ALL / undefined → the range alone, no scope adjustment.

  return Object.keys(filter).length > 0 ? filter : undefined;
}

// Start of today in UTC — the `now` reference for `@db.Date` columns, where a
// full-precision `new Date()` would push a row dated today into `past` the
// moment the wall clock passes midnight UTC.
export function startOfTodayUtc(): Date {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  return startOfToday;
}
