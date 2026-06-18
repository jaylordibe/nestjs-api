import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// Cross-field guard for a pair of "HH:mm" wall-clock fields: the decorated
// property must be strictly later than the sibling named in `startProperty`.
//
// Both values are validated elsewhere as zero-padded `HH:mm`, so a plain
// lexicographic string comparison is chronologically correct ("09:30" >
// "08:00") — no parsing needed.
//
// No-ops (returns valid) when the decorated value is null/undefined: the field
// it guards is optional (e.g. a schedule's `endTime` — absent = a single
// departure time rather than a window). Format validation stays the job of the
// `@Matches(HHMM)` on each field; this only enforces the ordering.
export function IsAfterTime(
  startProperty: string,
  validationOptions?: ValidationOptions,
) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isAfterTime',
      target: object.constructor,
      propertyName,
      constraints: [startProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (value === null || value === undefined) return true;
          if (typeof value !== 'string') return false;
          const [startName] = args.constraints as [string];
          const start = (args.object as Record<string, unknown>)[startName];
          // If the sibling isn't a usable string, defer to its own validators
          // rather than failing here on an unrelated problem.
          if (typeof start !== 'string') return true;
          return value > start;
        },
        defaultMessage(args: ValidationArguments): string {
          const [startName] = args.constraints as [string];
          return `$property must be later than ${startName}`;
        },
      },
    });
  };
}
