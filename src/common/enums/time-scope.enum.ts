// Tri-state filter for list endpoints that split rows by a datetime column
// relative to "now". Resource-agnostic — each consumer maps it onto its own
// moment-in-time column (appointments → scheduledAt, subscriptions →
// expiresAt, and so on).
//
// `all` is explicit (rather than omitting the param) so OpenAPI documents the
// three valid values and a client can round-trip a "show everything" toggle
// without reasoning about undefined.
//
// Ships unused: no resource in the template has a datetime column worth
// scoping yet. It is here so the first one that does inherits a filter whose
// bound-precedence rules are already settled — see `buildTimeScopeFilter`.
// If you expose it in a query DTO, remember the enums module needs BOTH a
// registry entry and its own `@Get()` route.
export enum TimeScope {
  UPCOMING = 'upcoming',
  PAST = 'past',
  ALL = 'all',
}
