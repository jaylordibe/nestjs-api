// Indexing an array or record is `T | undefined` under noUncheckedIndexedAccess.
// When a spec needs the element itself — to pass it on, or to assert something
// a missing value would satisfy vacuously (`not.toHaveProperty`) — take it
// through these: a missing element fails here, by name, instead of surfacing as
// a TypeError inside the next assertion or passing when it should not.
//
// An assertion that would already fail on `undefined` (`toBe(expected)`) needs
// neither; optional chaining (`rows[0]?.status`) keeps it honest.

export function firstElement<T>(items: readonly T[], label: string): T {
  const [first] = items;
  if (first === undefined) {
    throw new Error(`Expected at least one ${label}, got none`);
  }
  return first;
}

export function definedValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${label} to be present`);
  }
  return value;
}
