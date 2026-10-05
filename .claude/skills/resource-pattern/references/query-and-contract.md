# Service, list query, and relation reference

Scoping (`AbilityScopedQueryService`, never a role check, server-derived owner
ids) is owned by `src/common/authorization/README.md`; the skeleton code is in
`docs/resource-pattern.md`. This file holds what neither states.

## Service methods

- `create(dto, actorId)`
  - derive authoritative fields server-side;
  - write `createdBy` and `updatedBy`;
  - use a transaction when related invariants are created together;
  - refetch with the standard include before returning.

- `findPaginated(query, ability/context)`
  - build one scoped/filter/search `where`;
  - build deterministic allowed `orderBy`;
  - run `findMany` and `count` in one transaction;
  - return DTOs plus pagination metadata.

- `findById(id, ability/context)`
  - include tenant/ownership/soft-delete visibility in the query;
  - throw `Errors.resourceNotFound` when invisible/missing.

- `update(id, dto, actorId, ability/context)`
  - load visible row;
  - verify action when required;
  - write `updatedBy`;
  - preserve immutable/server-owned fields;
  - refetch standard response shape.

- `remove(id, actorId, ability/context)`
  - load visible row;
  - enforce action;
  - apply the chosen hard/soft/erasure lifecycle atomically.

## List query

`buildListArgs` (a private method per service) is the single source for the
sort allowlist and fallback deterministic sort (`buildOrderBy`), and is where a
search/filter `where` is added. Ability/tenant scope comes from
`AbilityScopedQueryService.buildWhere`, soft-delete scope from `prisma.scoped`,
and pagination is `skip`/`take` from `MetaQueryDto` in `findPaginated`.

- never pass an untrusted `sortBy` string directly to Prisma;
- apply the identical `where` to `findMany` and `count`;
- resource filters extend a validated DTO — never read raw query strings.

Search:

- trim and ignore whitespace-only input;
- use case-insensitive PostgreSQL search where appropriate;
- include explicit nested soft-delete filters;
- keep search fields intentional, and indexed when scale requires it.

## Loaded relations

1. define and export the typed row shape;
2. use one standard include constant;
3. destructure raw relation keys before `Object.assign`;
4. wrap loaded relations in their own response DTOs;
5. omit an unloaded relation instead of inventing `null`.

Refetch with the standard include after create and update so their response
shapes match `findById`.
