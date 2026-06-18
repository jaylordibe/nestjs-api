import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// Cross-field equality validator. Asserts the decorated property equals
// another property on the same DTO — the standard "confirm password /
// confirm email" guardrail. Runs at the ValidationPipe layer (→ 400
// VALIDATION_FAILED), so confirmation mismatches never reach the service:
// the contract is enforced by the type, not by hand-written checks the
// next contributor could forget. Use as `@Match('newPassword')` on the
// confirmation field.
export function Match(property: string, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'match',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [relatedPropertyName] = args.constraints as [string];
          const relatedValue = (args.object as Record<string, unknown>)[
            relatedPropertyName
          ];
          return value === relatedValue;
        },
        defaultMessage(args: ValidationArguments): string {
          const [relatedPropertyName] = args.constraints as [string];
          return `${args.property} must match ${relatedPropertyName}`;
        },
      },
    });
  };
}
