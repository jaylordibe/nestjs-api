// Canonical `HH:mm` 24-hour wall-clock pattern (zero-padded). Anchored so
// trailing junk is rejected. Hours are capped at 23 (`[01]\d` = 00–19,
// `2[0-3]` = 20–23) and minutes at 59 (`[0-5]\d`), so `24:00`, `25:30`, and
// `09:60` all fail. Midnight is `00:00` (there is no `24:00` form).
//
// Single source of truth for every `HH:mm` field across the API — schedule
// start/end times, pickup times, program-step times, booking requested times.
// Use with class-validator's `@Matches(HHMM_PATTERN, …)`.
export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
