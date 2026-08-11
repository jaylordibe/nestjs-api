---
name: authorization
description: This repository's answers for RBAC and CASL — the permission catalog as source of truth, the one access decorator every route declares, AbilityScopedQueryService as the only query-scoping path, the 404-versus-403 rule, escalation rank, and grants-cache invalidation.
when_to_use: Use when adding or changing permissions, roles, business-scoped resources, @RequirePermission, @AuthenticatedOnly, @Public, AbilityScopedQueryService, permission catalogs, ownership rules, administrative routes, role assignment, or authorization tests.
user-invocable: false
---

# Authorization: RBAC + CASL — this repository's answers

The `engineering-framework:domain-authorization` skill carries the questions and
failure modes that govern any authorization change — including why isolation
belongs in the query rather than the guard. This file carries **only this
repository's answers**.

Read first:

- `src/common/authorization/README.md` — the contract
- `src/common/authorization/permission-catalog.ts`
- `src/modules/authorization/**`
- relevant authorization e2e specs

The README and source are the contract. This skill is the working checklist.

## Permission model

- A permission records **what**: action + subject. Never a runtime ownership or
  tenant condition.
- `AbilityFactory` derives the **where** from `scope` (`RoleScope`) and
  `ownership` (`PermissionOwnership`).
- `PERMISSION_CATALOG` is the source of truth; database rows are a projection of
  it. `PermissionCatalogIntegrityService` fails the boot on drift;
  `yarn rbac:check` is the read-only check and `yarn prisma:seed` reconciles.
- Never hand-edit permission or seeded-role rows.
- JWT carries `{ sub, jti }` only. `@CurrentUser()` returns `AuthenticatedUser`
  (id/email) and deliberately **does not expose a role**.

## Route declaration

Every handler declares exactly one of `@Public()`, `@AuthenticatedOnly()`, or
`@RequirePermission(action, subject, options?)` — or the application **refuses to
boot** (`RouteAuthorizationAuditService`).

`JwtAuthGuard` and `PermissionsGuard` are global `APP_GUARD`s. Controllers never
apply them.

Any new `@Public()` endpoint also needs an explicit route-level `@Throttle` and a
leakage assessment.

## Query scoping

Scope every read through `AbilityScopedQueryService`:

- `buildWhere`
- `buildWhereOrEmpty`
- `buildRecordWhere`

**Never import `@casl/prisma` anywhere else — ESLint blocks it.** Prisma silently
drops an empty `OR: []` nested inside `AND`, so the obvious hand-rolled merge
returns *every row* to a caller with no rules. Preserve the service's proven
composition rather than re-deriving it.

Never inspect a role in a controller or service to decide row visibility.

## 404 versus 403

```text
caller cannot read/locate the record  → 404   (a 403 would confirm it exists)
caller can read it, may not act on it → 403
```

Canonical flow: load through a record-scoped query → 404 when no visible row
exists → evaluate the action on the resolved record → 403 only when the row is
visible but the action is denied.

## Route options

- `{ administrative: true }` — the operation intentionally acts beyond
  caller-owned rows, and requires a grant that is not owner-conditioned. An
  own-record permission must never unlock an administrative route.
- `{ denyAsNotFound: true }` — converts missing grant/visibility into an empty
  list or 404 where the public contract requires existence hiding. Pair it with
  the matching `...OrEmpty` query method.

## Dual-scoped subjects

A subject may be both owner-scoped and business-scoped. For a dual-scoped model:
register both owner and tenant keys; ensure the guard stub includes both; allow
rules to OR-compose through the authorization service; re-check the resolved
target when acting on another user's row.

Do not model a customer relationship as a role or business membership unless the
domain contract says it is one.

## Escalation and role assignment

Role assignment is a distinct permission/action — a broad update or a CASL
`manage` wildcard must not bypass the escalation guard. A caller may grant only
roles allowed by the rank rule. **Rank exists for escalation comparison only and
does not imply permission inheritance.**

## Cache invalidation

| Change | Call |
|---|---|
| user role/membership | `permissionLoaderService.invalidateUser(userId)` |
| role permission-set | `permissionLoaderService.invalidateAllUsers()` |

Never leave stale grants active for the cache TTL.

## Common change procedures

### Add a permission

1. Add it to `PERMISSION_CATALOG`.
2. Add it to the correct seeded role definition when appropriate.
3. Apply exactly one access decorator to the route.
4. Scope data access through `AbilityScopedQueryService`.
5. Add positive and negative authorization tests.
6. Run `yarn rbac:check`.
7. Let the isolated test setup seed its own test database; never re-seed local
   data autonomously.

### Add a business-scoped model

1. Add the `businessId` relation/index.
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
3. Never accept a client-supplied owner ID as authoritative — derive owner/actor
   fields from the authenticated server context.
4. Test owner, non-owner, platform admin, and business staff behavior.

## Audit

Record privileged authorization actions through `AuditService`, with actor,
target, action, and safe metadata. Never let caller-provided request-envelope
metadata override the server-vouched request context.

## Required tests

Use shared RBAC fixtures after `truncateAll`. Cover as relevant: 401
unauthenticated; no grant; correct grant; owner versus non-owner; same-business
versus cross-business; PLATFORM versus BUSINESS scope; invisible record returns
404; visible but forbidden action returns 403; administrative route not unlocked
by an own-only permission; dual-scoped owner/staff behavior; escalation/rank
denial; grants-cache invalidation; permission catalog integrity; stable
`errorCode`, never message text.

Use the `e2e-testing` skill for harness details.
