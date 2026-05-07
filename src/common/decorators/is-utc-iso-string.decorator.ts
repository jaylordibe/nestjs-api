import { registerDecorator, ValidationOptions } from 'class-validator';

// Strict UTC ISO 8601 datetime — accepts:
//   2026-04-30T13:40:03Z
//   2026-04-30T13:40:03.004Z
//   2026-04-30T13:40:03+00:00
//   2026-04-30T13:40:03.004-00:00
//   (fractional seconds 1–9 digits permitted)
// Rejects:
//   - Naive strings without a zone designator (`2026-04-30T13:40:03`)
//   - Non-UTC offsets (`+03:00`, `-05:00`, …)
//   - Bare dates (`2026-04-30`) — those belong on date-only columns and
//     should use @IsDateString instead
//
// Why bother when the DB stores naive UTC wall-clock anyway? Because
// the alternative is silently accepting `+03:00` from a frontend in a
// non-UTC timezone, dropping the offset on parse, and persisting the
// wall-clock as if it were UTC — a multi-hour drift the user never
// sees because the API echoes back the same ISO string. Enforcing
// `Z` (or `±00:00`) at the boundary kills that ambiguity.
const UTC_ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]00:?00)$/;

export function IsUtcIsoString(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isUtcIsoString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          if (!UTC_ISO_DATETIME_PATTERN.test(value)) return false;
          // Regex matches the shape; also confirm the date/time itself
          // is real so 2026-02-30 / 2026-13-01 don't sneak through.
          const parsed = new Date(value);
          return !Number.isNaN(parsed.getTime());
        },
        defaultMessage(): string {
          return '$property must be a UTC ISO 8601 datetime string (e.g. 2026-04-30T13:40:03.004Z)';
        },
      },
    });
  };
}
