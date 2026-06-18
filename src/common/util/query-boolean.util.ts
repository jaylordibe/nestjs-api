// Query strings arrive as strings, and the global ValidationPipe runs
// `enableImplicitConversion`, which coerces a Boolean-typed field with
// `Boolean(value)` — so the string 'false' becomes `true` and inactive
// rows can never be listed. The fix: pair this @Transform with
// `@Type(() => String)` to opt the field out of implicit Boolean
// coercion (it stays a string), then map the two literals explicitly.
// Anything else (empty, garbage) becomes undefined so `@IsOptional`
// skips it.
//
//   @IsOptional()
//   @Type(() => String)
//   @Transform(toOptionalBoolean)
//   @IsBoolean()
//   isActive?: boolean;
export const toOptionalBoolean = ({
  value,
}: {
  value: unknown;
}): boolean | undefined =>
  value === true || value === 'true'
    ? true
    : value === false || value === 'false'
      ? false
      : undefined;
