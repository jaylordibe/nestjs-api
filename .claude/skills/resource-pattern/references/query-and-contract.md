# Query, service, DTO, and contract reference

## Service methods

Typical responsibilities:

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

Do not catch standard Prisma errors already owned by the global filter.

## List query

Use `MetaQueryDto` and repository defaults/limits.

`buildListArgs` is the single source for:

- allowed sort fields;
- fallback deterministic sort;
- search;
- resource-specific filters;
- ability/tenant scope;
- soft-delete scope;
- pagination.

Never pass an untrusted `sortBy` string directly to Prisma.

Apply the identical `where` to `findMany` and `count`.

Search:

- trim/ignore whitespace-only input;
- use case-insensitive PostgreSQL search where appropriate;
- include explicit nested soft-delete filters;
- keep search fields intentional and indexed when scale requires it.

Resource filters extend a validated DTO. Do not read raw query strings.

## Actor and ownership scoping

Do not use `current.role` to scope lists.

The authenticated user contract intentionally omits role authority.

Use:

- explicit route semantics for `/me`-style behavior;
- ability/ownership/tenant predicates from `AbilityScopedQueryService`;
- server-derived owner IDs;
- validated client filters only as optional narrowing, never as authorization.

## Response DTOs and relations

Always return `new <Resource>ResponseDto(row)`.

For sensitive fields, combine:

- `@Exclude()` for runtime;
- `@ApiHideProperty()` for Swagger.

For loaded relations:

1. define/export the typed row shape;
2. use one standard include constant;
3. destructure raw relation keys before `Object.assign`;
4. wrap loaded relations in their own response DTOs;
5. omit an unloaded relation instead of inventing `null`.

Keep create/update response shapes consistent by refetching with the standard
include.

## Swagger

- paginated: `@ApiPaginatedResponse(ResourceResponseDto)`;
- create: explicit `@ApiCreatedResponse`;
- find/update: explicit `@ApiOkResponse`;
- delete: 204;
- JWT routes: `@ApiBearerAuth`;
- mapped DTOs import from `@nestjs/swagger`;
- side-effect endpoints return shared typed acknowledgement DTOs;
- redirects document the actual redirect status.

## Consumer compatibility

A changed field, nullability, enum, error code, order, pagination, or relation
shape is a public contract change.

Identify web/mobile/external consumers, deployment order, and mixed-version
behavior before implementation.
