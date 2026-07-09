---
name: nestjs-authorization
description: Use when touching authorization — adding or changing a permission, role, or business-scoped resource; writing/altering @RequirePermission, @AuthenticatedOnly, or @Public on a handler; working in src/modules/authorization/ or src/common/authorization/; deciding 403 vs 404; anything involving CASL abilities, accessibleBy, tenant isolation, the rank/escalation guard, or the grants cache.
---

# Authorization (RBAC + CASL)

**Read `src/common/authorization/README.md` first.** It is the contract. This
skill is the working checklist.

## Non-negotiables

1. **A permission row stores WHAT (action + subject). Never a condition.**
   `AbilityFactory` derives the condition from `scope` + `ownership` + request
   context. Do not add a `condition` column.

2. **Tenant isolation lives in the QUERY, not the guard.** A guard runs before
   the row is loaded, and CASL ignores conditions on a subject-*type* check.
   Use `AbilityScopedQueryService`.

3. **Never call `accessibleBy` outside `AbilityScopedQueryService`.** ESLint
   blocks it. Prisma silently drops an empty `OR: []` nested inside `AND`, so
   `{ AND: [callerWhere, fragment] }` returns EVERY ROW to a caller with no
   rules. The safe shape is `{ ...fragment, AND: [callerWhere] }`.

4. **The database is a projection of `permission-catalog.ts`.** Never hand-edit
   `permissions` or seeded `roles`. The app refuses to boot on drift; run
   `yarn prisma:seed`, verify with `yarn rbac:check`.

5. **Every handler declares exactly one** of `@Public()`,
   `@AuthenticatedOnly()`, `@RequirePermission(...)`. Otherwise the app will not
   start (`RouteAuthorizationAuditService`).

## 403 vs 404

```
cannot READ the record        → 404   (never confirm existence across a tenant)
can read it, cannot act on it → 403   (they already see it; 404 would be a lie)
```
Canonical shape: `BusinessesService.findById` (404) then `assertMayAct` (403).

## Decorator options

- `{ administrative: true }` — the route acts on records the caller does not
  own. Demands a granting rule that is NOT owner-conditioned. Without it,
  `update User (own)` unlocks `PATCH /users/:id`.
- `{ denyAsNotFound: true }` — no grant at all ⇒ empty page / 404, not 403.
  Pair with `buildWhereOrEmpty` / `buildRecordWhereOrEmpty`.

## Adding a permission
1. `PERMISSION_CATALOG` entry → 2. grant it in `ROLE_DEFINITION_CATALOG` →
3. `yarn prisma:seed` → 4. `@RequirePermission('action', 'Subject')`.

## Dual-scoped subjects (ownable AND tenant-scoped)
`BusinessCustomer` is registered in BOTH `SUBJECT_OWNER_KEY` (`userId`) and
`SUBJECT_TENANT_KEY` (`businessId`). Rules OR-compose, so one endpoint serves
the owner of the row and the staff of the tenant. The guard checks a stub with
**both** keys (`buildTenantStub`); acting on someone ELSE's record must be
re-checked in the service against the resolved target id.

Do NOT model a customer as a role or a `business_members` row.

## Adding a business-scoped model
1. Prisma model with `businessId` → 2. add to `AUTHORIZATION_SUBJECTS` →
3. `SUBJECT_TENANT_KEY` → 4. `WhereInputBySubject` → 5. read via
`AbilityScopedQueryService`. Steps 2–4 are compiler-enforced; 5 is lint-enforced.

## Escalation guard
`assignRole` is separate from `update` (CASL's `manage` wildcard would swallow
it). On top: you may grant a role **at or below** your own `rank`, never above.
`rank` orders roles for THIS CHECK ONLY — it never implies inherited permissions.

## Cache invalidation
- user's roles/memberships change → `permissionLoaderService.invalidateUser(userId)`
- a **role's** permission set changes → `invalidateAllUsers()` (epoch `INCR`)

Forgetting this leaves a user with stale authority for up to the TTL (300s).

## Testing
Use `test/setup/rbac.ts`: `seedRbacCatalog(app)` in `beforeEach` (after
`truncateAll` — it wipes roles/permissions), then `createPlatformAdmin`,
`createRegularUser`, `createPlatformUser(app, { roles })`.
Assert `body.errorCode`, never `message`.
