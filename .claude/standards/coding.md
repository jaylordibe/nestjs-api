# Coding standard — project edition

`CLAUDE.md` is authoritative.

## Naming

Use full intention-revealing domain names everywhere.

Avoid cryptic abbreviations, vague placeholders, and single-letter locals/loop
counters except established idioms and generic type parameters allowed by
`CLAUDE.md`.

Declared names have the highest readability bar.

## Responsibilities

- controllers: transport and access metadata;
- DTOs: contract and validation;
- services/use cases: behavior and orchestration;
- repositories/Prisma: persistence;
- common utilities: pure reusable transforms;
- config/registry modules: static tables and registries.

Do not place large data registries or reusable pure functions above a service
class.

## Errors and responses

- use `Errors.*`;
- preserve stable `errorCode`;
- do not catch Prisma errors already translated globally;
- return response DTO instances;
- protect sensitive fields at runtime and Swagger build time;
- do not expose internal errors.

## Data and persistence

- validate and normalize at trust boundaries;
- never trust client-computed authoritative fields;
- parameterize persistence operations;
- include ownership/tenant scope;
- address concurrency;
- avoid N+1 and unbounded reads;
- maintain deterministic pagination;
- follow soft-delete and partial-index rules.

## External operations

- typed provider helpers;
- explicit timeouts;
- bounded transient retries;
- idempotent retried writes;
- duplicate-safe consumers;
- safe payload/log handling.

## Completion hygiene

No debug output, TODO deferrals for in-scope migration, focused tests, disabled
checks, commented-out code, obsolete parallel implementations, or accidental
lockfile/generated changes.
