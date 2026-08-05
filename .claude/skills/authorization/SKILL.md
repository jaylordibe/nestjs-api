---
name: authorization
description: Applies this repository's DB-backed RBAC and CASL contract for permissions, roles, route metadata, PLATFORM/BUSINESS scope, ownership, query-level tenant isolation, 403-versus-404 behavior, escalation controls, and grants-cache invalidation.
when_to_use: Use when adding or changing permissions, roles, business-scoped resources, @RequirePermission, @AuthenticatedOnly, @Public, AbilityScopedQueryService, permission catalogs, ownership rules, administrative routes, role assignment, or authorization tests.
user-invocable: false
---

# Authorization: RBAC + CASL

Read first:

- `CLAUDE.md`
- `src/common/authorization/README.md`
- `src/common/authorization/permission-catalog.ts`
- `src/modules/authorization/**`
- relevant authorization e2e specs

The README and source are the contract. This skill is the working checklist.

## Non-negotiable invariants

### Permission model

- A permission records **what** may be done: action + subject.
- Never store runtime ownership or tenant conditions in permission rows.
- `AbilityFactory` derives conditions from scope, ownership, and request/user
  context.
- The permission catalog is the source of truth; database rows are a projection.
- Never hand-edit permission or seeded-role rows.
- JWT carries identity/session only; never put role or permission authority in
  token claims.

### Route declaration

Every handler declares exactly one:

- `@Public()`
- `@AuthenticatedOnly()`
- `@RequirePermission(action, subject, options?)`

Global guards already enforce authentication and permissions. Do not add them to
controllers.

`RouteAuthorizationAuditService` must continue to fail closed on missing or
ambiguous route metadata.

Any new `@Public()` endpoint must also be assessed for explicit route-level
throttling and information leakage.

### Tenant and object isolation

Tenant isolation lives in the Prisma query, not in the guard.

A guard can prove that a matching rule exists. It cannot prove that the caller
may access the specific row that has not yet been loaded.

Use only `AbilityScopedQueryService`:

- `buildWhere`
- `buildWhereOrEmpty`
- `buildRecordWhere`
- established `...OrEmpty` variants where applicable

Never import or call `@casl/prisma` elsewhere.

Do not merge ability fragments with a shape that lets Prisma discard an empty
nested `OR: []`. Preserve the service's proven composition.

Do not inspect a role in a controller or service to decide row visibility.
`@CurrentUser()` intentionally does not expose a role. Scope by ability,
ownership, tenant, and explicit route semantics.

### 404 versus 403

```text
caller cannot read/locate the record
→ 404, to avoid confirming cross-tenant existence

caller can read the record but cannot perform the action
→ 403
```

Canonical flow:

1. load through a record-scoped query;
2. return 404 when no visible row exists;
3. evaluate the action on the resolved record;
4. return 403 only when the row is visible but the action is denied.

### Administrative routes

`{ administrative: true }` means the operation intentionally acts beyond
caller-owned rows. It requires a grant that is not owner-conditioned.

Do not let an own-record permission unlock an administrative route.

`{ denyAsNotFound: true }` converts missing grant/visibility to an empty list or
404 where the public contract requires existence hiding. Pair it with the
established `...OrEmpty` query method.

### Dual-scoped subjects

A subject may be both owner-scoped and business-scoped.

For a dual-scoped model:

- register both owner and tenant keys;
- ensure the guard stub includes both keys;
- allow rules to OR-compose through the authorization service;
- re-check the resolved target when acting on another user's row.

Do not model a customer relationship as a role or business membership unless
the domain contract explicitly says it is one.

### Escalation and role assignment

Role assignment is a distinct permission/action; do not let a broad update or
CASL `manage` wildcard bypass the escalation guard.

A caller may grant only roles allowed by the established rank rule. Rank exists
for escalation comparison only and does not imply permission inheritance.

### Cache invalidation

When authority changes:

- user role/membership change:
  `permissionLoaderService.invalidateUser(userId)`
- role permission-set change:
  `permissionLoaderService.invalidateAllUsers()`

Do not leave stale grants active for the cache TTL.

## Common change procedures

### Add a permission

1. Add the permission to `PERMISSION_CATALOG`.
2. Add it to the correct seeded role definition when appropriate.
3. Apply exactly one access decorator to the route.
4. Scope data access through `AbilityScopedQueryService`.
5. Add positive and negative authorization tests.
6. Run the read-only RBAC integrity check supported by the repository.
7. Let isolated test setup seed its test database; do not re-seed local data
   autonomously.

### Add a business-scoped model

1. Add the `businessId` relation/index required by the data model.
2. Add the subject to `AUTHORIZATION_SUBJECTS`.
3. Add its tenant key.
4. Add its Prisma `WhereInput` mapping.
5. Use scoped list and record queries.
6. Verify PLATFORM and BUSINESS actors separately.
7. Verify cross-business access returns 404.
8. Verify ownership and administrative behavior independently.

### Add an owner-scoped model

1. Register the owner key.
2. Build list and record visibility through the authorization service.
3. Do not accept a client owner ID as authoritative.
4. Derive owner/actor fields from the authenticated/server context.
5. Test owner, non-owner, platform admin, and business staff behavior as
   applicable.

## Audit requirements

Record privileged and security-sensitive authorization actions through
`AuditService`.

Include actor, target, action, and safe metadata. Never allow caller-provided
request-envelope metadata to override the server-vouched request context.

## Required tests

Use shared RBAC fixtures after `truncateAll`.

Cover as relevant:

- 401 unauthenticated;
- no grant;
- correct grant;
- owner versus non-owner;
- same-business versus cross-business;
- PLATFORM versus BUSINESS scope;
- invisible record returns 404;
- visible but forbidden action returns 403;
- administrative route cannot be unlocked by own-only permission;
- dual-scoped owner/staff behavior;
- escalation/rank denial;
- grants-cache invalidation;
- permission catalog integrity;
- stable `errorCode`, never message text.

Use the `e2e-testing` skill for harness details.
