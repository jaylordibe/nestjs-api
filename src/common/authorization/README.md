# Authorization contract (RBAC + CASL)

This is the companion to `src/common/errors/README.md`. Read it before touching
anything under `src/modules/authorization/` or any `@RequirePermission`
decorator.

---

## The model in one paragraph

A **permission** is a tuple `(action, subject, scope, ownership)` defined once
in [`permission-catalog.ts`](./permission-catalog.ts). A **role** is a named
bundle of permissions. A user holds PLATFORM roles through `user_roles`, and
BUSINESS roles through `business_memberships` — exactly one row per business, in
any capacity. On every request, `PermissionsGuard` loads the caller's grants
(Redis-cached, DB-backed) and compiles them into a single CASL `Ability`.
Handlers declare what they need; queries enforce which rows the caller may touch.

Most accounts hold **no platform role at all**. Self-service capability comes
from `AUTHENTICATED_USER_PERMISSIONS`, which `AbilityFactory` injects for every
authenticated caller — so a user with zero roles and zero memberships is a
complete, working account rather than a broken one.

The database is a **projection** of the catalog. The app refuses to boot if they
disagree.

---

## Two principles

Everything else follows from these. If you are about to violate one, stop.

### 1. The DB stores *what*; the factory injects *where*

A permission row records only an action and a subject. It **never** stores a
condition. `AbilityFactory` derives the condition from the row's `scope` and
`ownership` plus request context:

| scope | ownership | CASL rule produced |
|---|---|---|
| `platform` | `any` | `can(action, subject)` — unconditional |
| `platform` | `own` | `can(action, subject, { [ownerKey]: userId })` |
| `business` | (always `any`) | `can(action, subject, { [tenantKey]: businessId })` |

`ownerKey` and `tenantKey` come from [`subject-key.ts`](./subject-key.ts).

This is why `permissions` has no `condition` column, and why you never write a
template language into Postgres.

### 2. The guard proves a rule *exists*; the query proves the row is *reachable*

A guard runs **before** the record is loaded. CASL, by design, ignores rule
conditions when you check against a subject *type* rather than an *instance*:

```ts
ability.can('update', 'Business')                          // type     → ignores conditions
ability.can('update', subject('Business', loadedRow))      // instance → evaluates them
```

So **tenant isolation cannot live in a guard.** It lives in the query, via
`AbilityScopedQueryService`. A row the caller may not reach is never loaded, so
they get a 404 rather than a 403 — which is also the right answer, since a 403
confirms the record exists.

---

## ⚠️ The Prisma empty-`OR` landmine

Verified against Prisma 7.7 + Postgres 16. When a caller holds **no** rules for
a subject, `accessibleBy(...).ofType(M)` returns `{ OR: [] }`. Prisma's handling
depends on *where that fragment sits*:

| shape | SQL | result |
|---|---|---|
| `{ OR: [] }` | `WHERE 1=0` | ✅ matches nothing |
| `{ id, OR: [] }` (sibling key) | `WHERE 1=0` | ✅ matches nothing |
| `{ AND: [{ id }, { OR: [] }] }` | `WHERE id = …` | 🚨 **empty OR dropped** |
| `{ AND: [{ OR: [] }] }` | `WHERE 1=1` | 🚨 **returns every row** |

The obvious merge — `where: { AND: [callerWhere, fragment] }` — is a **total
authorization bypass** for any principal with no rules on that subject.

The only safe composition spreads the fragment at the top level:

```ts
{ ...accessibleBy(ability, action).ofType(model), AND: [callerWhere] }
```

`AbilityScopedQueryService` is the single place this is written. It fails closed
twice more (rule-existence check, then an explicit empty-`OR` check), and
`ability-scoped-query.service.spec.ts` asserts the emitted **shape** so a
refactor breaks the build instead of the tenant boundary. **An ESLint rule
forbids importing `@casl/prisma` anywhere else.**

For "no grant means empty, not forbidden", the empty-set filter is
`{ id: { in: [] } }` — it compiles to `WHERE 1=0` *and* survives `AND` nesting.

---

## Declaring authorization on a handler

Every handler carries **exactly one** of these. A handler with none fails the
boot-time route audit and the application refuses to start.

```ts
@Public()                                     // anonymous
@AuthenticatedOnly()                          // valid JWT, no subject to check
@RequirePermission(action, subject, options)  // typed against the catalog
```

`@RequirePermission` attaches its own Swagger responses, so a protected route
cannot be documented as open. Its arguments are typed, so a typo is a **compile
error**, not a runtime 403.

### `options.administrative`

Marks a route that acts on records the caller does not own.

Without it, the intrinsic `update User (own)` that EVERY authenticated caller
holds would pass the guard on `PATCH /users/:id` — a rule *does* exist, and the
guard cannot see its
condition. With it, the guard demands a granting rule that is **not**
owner-conditioned. Tenant-conditioned rules still qualify: a `BUSINESS_ADMIN`
administers a roster it does not personally own.

### `options.denyAsNotFound`

Answer a caller holding **no** grant on this subject as though the resource does
not exist — empty page for a list, 404 for a record — rather than 403.

Two reasons. It is *truthful*: a user who belongs to no business is not
forbidden from listing businesses, they have none. And it is *consistent*:
without it, a user **with** a business gets 404 on someone else's business (the
query filters it out) while a user with **none** gets 403 from the guard — the
same request answered two ways depending on state the caller cannot see.

### 404 vs 403 — the rule

```
cannot READ the record        → 404   (never confirm existence across a tenant)
can read it, cannot act on it → 403   (they already see it; a 404 would be a lie)
```

See `BusinessesService.findById` + `assertMayAct` for the canonical shape.

---

## Adding a permission

1. Add a `PermissionDefinition` to `PERMISSION_CATALOG`.
2. Grant it to the relevant roles in `ROLE_DEFINITION_CATALOG`.
3. `yarn rbac:sync` (idempotent: inserts, updates descriptions, deletes orphans).
4. Use it: `@RequirePermission('yourAction', 'YourSubject')`.

`yarn rbac:check` verifies the database matches; CI runs it, and the deploy's
`migrate` service runs `rbac:sync` after `prisma migrate deploy`. **The app will
not boot on drift**, so catalog projection is a deploy step, never a manual one.

`yarn prisma:seed` = `rbac:sync` + the bootstrap admin/demo users. It needs
`SEED_*` env; `rbac:sync` needs only `DATABASE_URL`. Deploys run the latter.

**Never hand-edit `permissions` or seeded `roles` rows.** They are code.

## Adding a business-scoped model

1. Add the Prisma model with a `businessId` column.
2. Add its name to `AUTHORIZATION_SUBJECTS`.
3. Register its tenant key in `SUBJECT_TENANT_KEY` (one line).
4. Add it to `WhereInputBySubject` in `ability-scoped-query.service.ts`.
5. Read it through `AbilityScopedQueryService`. Never `prisma.<model>.findUnique`
   with a raw id.

Steps 2–4 are enforced by the compiler; step 5 by the ESLint rule.

## Roles are code — there is no runtime role API

`GET /roles` and `GET /permissions` are the only role endpoints. There is no
`POST`, `PATCH`, or `DELETE`, and their absence is the feature: an operator who
can add `platform.all.manage` to a role they already hold has made themselves an
admin with no diff for anyone to review.

Two things also make a runtime role API structurally unworkable here.
`PermissionCatalogIntegrityService` refuses to boot when the database and the
catalog disagree, and the seeder reconciles every seeded role's grants back to
the catalog — so a custom role's permissions would be reverted by the next
deploy anyway.

`GET /roles?assignableIn=<businessId>` narrows the list to roles the caller may
actually hand out there (business-scoped, at or below their rank). That is
ergonomics, not a control — the ceiling is enforced on write regardless — but a
picker that only offers reachable options is the difference between a boundary
users understand and one they probe.

---

## The escalation guard

`assignRole`, `suspend`, and `transferOwnership` are permissions distinct from
`update`, because CASL's `manage` wildcard would otherwise swallow all three —
and `manage BusinessMembership` would let a `BUSINESS_ADMIN` promote itself to
owner.

**No BUSINESS-scoped role holds `manage`, including `BUSINESS_OWNER`.** The
owner genuinely holds every verb today, so `manage` would be equivalent *right
now* — and would silently grant whatever verb is added to the vocabulary next,
with nobody reviewing that decision. `permission-catalog.spec.ts` asserts it.

On top of the permission, `rank` bounds it:

> You may grant, or act upon, a role **at or below** your own rank — never one
> above it.

At-or-below is deliberate. A lateral grant is not an escalation (a
`BUSINESS_ADMIN` minting a peer admin gains nothing it lacked), and
strictly-below would make appointing a co-owner impossible — which would in turn
make the last-owner invariant's advice ("promote another member first")
unreachable.

`rank` orders roles **for this check only**. It does *not* imply inherited
permissions. `BUSINESS_ADMIN` does not contain `BUSINESS_MEMBER`, and
`PLATFORM_ENGINEER` (rank 90) holds no governance despite outranking both
support roles — it is deliberately never granted `assignRole User`, so the
highest *technical* authority on the platform cannot promote itself into the
highest *governance* authority. Every role's grants are listed explicitly.
Conflating "outranks" with "inherits" is how RBAC systems rot.

The ceiling is measured against the caller's **ACTIVE** membership. A suspended
owner still reads rank 100 on paper and must hold nothing in fact.

---

## Caching and invalidation

Grants (not abilities — CASL rules don't round-trip through JSON) are cached in
Redis under `authz:v1:grants:{epoch}:{userId}`.

| change | invalidation |
|---|---|
| platform role assigned or revoked | `DEL` that one key |
| membership added, role changed, suspended, reactivated, or ended | `DEL` that one key |
| invitation accepted | `DEL` the acceptor's key |
| ownership transferred | `DEL` **both** parties' keys |
| business soft-deleted | `DEL` every membership holder's key — every status, not just active, since a cached set written while they were active may still be live |
| a **role's** permission set changes | `INCR authz:epoch` — retires every cached grant at once |

Version the key (`v1` above) whenever `AuthorizationGrants` changes shape.
During a rolling deploy both builds are live at once, so without it the new code
reads an entry the old code wrote, deserializes it into a shape whose fields are
now `undefined`, and mis-authorizes for the rest of that key's TTL.

TTL (`AUTHORIZATION_GRANTS_CACHE_TTL_SECONDS`, default 300) is a **backstop for
a missed invalidation**, not the correctness mechanism. Redis being unavailable
falls through to the database — never to "allow".

Grants are **not** embedded in the JWT. This template issues 30-day tokens; a
revoked role must take effect on the next request, not in a month.

---

## Client-side ability sync

`GET /users/me/permissions` returns the caller's packed CASL rules:

```ts
import { createMongoAbility, subject } from '@casl/ability';
import { unpackRules } from '@casl/ability/extra';

const { rules } = await api.get('/users/me/permissions');
const ability = createMongoAbility(unpackRules(rules));

ability.can('update', subject('Business', business));  // same verdict as the server
```

One catalog, both sides. `test/authorization.e2e-spec.ts` asserts the rebuilt
client ability agrees with the server decision-for-decision. Client checks are a
**UI affordance**; the server re-checks everything on every request.

---

## One membership, staff and customers alike

`BusinessMembership` is the **only** relationship between a person and a
business. A customer is a membership holding `BUSINESS_CUSTOMER`, exactly as
staff is a membership holding `BUSINESS_MEMBER`. `@@unique([businessId, userId])`
is unconditional, so a person is one or the other in a given business — never
both.

That constraint is a real product decision, not an accident. It buys a
membership model with one table, one lifecycle, and one authorization path; it
costs the ability to represent someone who both works at a business and buys
from it. If your domain needs that (a stylist booking at their own salon), model
the *customer relationship* as its own project-specific resource and leave
`BusinessMembership` for authority.

It is the one subject in **both** key maps, and that duality is the design:

```ts
SUBJECT_OWNER_KEY  = { …, BusinessMembership: 'userId'     }  // your own row
SUBJECT_TENANT_KEY = { …, BusinessMembership: 'businessId' }  // the whole roster
```

The rules OR-compose, so one endpoint serves both audiences with no branching:
`GET /businesses/:businessId/memberships` returns a customer's single row, a
staff member's whole tenant, and everything to a platform admin. Because the
subject is ownable *and* tenant-scoped, `PermissionsGuard` checks a stub carrying
**both** keys — see `buildTenantStub`. Supplying only the tenant key would
silently deny a member whose rule is conditioned on `userId`.

### Lifecycle

`BusinessMembershipStatus` is `invited → active → suspended → left`, and the row
is **never deleted**. `DELETE` ends a membership by moving it to `left`; a
re-join moves that same row back to `active`. That is what lets the uniqueness
constraint stay unconditional — soft deletion could not, because SQL treats
`NULL != NULL`, so `@@unique([businessId, userId, deletedAt])` would accept two
live rows while reporting itself unique.

**Only `ACTIVE` confers authority**, filtered in `PermissionLoaderService`'s
query and asserted again in `AbilityFactory`. It cannot live in a guard: a guard
runs before the row is loaded and cannot see a status.

### Extending it for customer-owned resources

`BUSINESS_CUSTOMER` deliberately gets the smallest coherent grant — `read
Business`, plus the intrinsic read of its own membership. **No roster access**: a
customer must never enumerate staff or other customers.

To give customers authority over their own domain records (bookings, orders,
tickets), do **not** widen the membership role. Add the resource as its own
subject:

1. Add the Prisma model with a `userId` column (and `businessId` if staff also
   read it).
2. Add its name to `AUTHORIZATION_SUBJECTS`.
3. Register `SUBJECT_OWNER_KEY` (and `SUBJECT_TENANT_KEY` if tenant-scoped).
4. Define `own`-scoped PLATFORM permissions and add them to
   `AUTHENTICATED_USER_PERMISSIONS` — or business-scoped ones granted to
   `BUSINESS_CUSTOMER`, if the authority should end when the membership does.
5. Read it through `AbilityScopedQueryService`.

The template ships no booking or order module, because inventing one to
demonstrate this would be product surface masquerading as infrastructure.

## Invitations

An invited email need not belong to a user yet, which is the entire reason
`BusinessInvitation` is a separate model — `BusinessMembership.userId` is NOT
NULL.

When the address already has an account, an `INVITED` membership is written
alongside the invitation: it reserves the `(businessId, userId)` slot, shows the
person as pending on the roster, and grants nothing.

`POST /invitations/accept` is `@AuthenticatedOnly()`, not `@Public()`. Someone
without an account registers through the ordinary `/auth/register` first, which
keeps **one** registration policy (disposable-email blocking, verification,
lockout) instead of forking a second, less-guarded account-creation path behind a
bearer token. The token survives registration.

The caller's email must match the invitation's, or the token alone would be
sufficient and a forwarded invitation would let anyone join. Acceptance is a
conditional `UPDATE` out of `pending` inside the transaction that writes the
membership, so two simultaneous redemptions produce exactly one membership and
the loser's whole transaction rolls back.

## Scope integrity lives in the factory, not the schema

`AbilityFactory` branches on where a grant **arrived from**, never on what the
permission claims to be — and the platform branch emits an *unconditional* rule.
Business permissions are always `ANY`, so a business role assigned through
`user_roles` would compile to platform-wide authority with no tenant bound.

Both loops therefore drop any permission whose `scope` does not match the branch:

```ts
if (permission.scope !== RoleScope.PLATFORM) continue;   // platform loop
if (permission.scope !== RoleScope.BUSINESS) continue;   // membership loop
```

An earlier design carried a constant `scope` column plus a CHECK and a composite
FK on each assignment table. That guarded the **write** only, and the escalation
is on the **read** — it also could not see a stale grant set arriving from Redis,
which this can, because it sits after the cache. `continue` rather than `throw`:
a mis-scoped grant is a data fault, and failing the build would turn one bad row
into an outage for that account.

The write path still validates (`loadPlatformRole`,
`loadAssignableBusinessRole`), and `ability.factory.spec.ts` asserts both
directions.

## Deliberate non-goals

**No role hierarchy.** See the escalation guard above.

**No per-user permission overrides.** Permissions flow only through roles.

**No field-level CASL rules.** Response redaction stays with Response DTOs +
`@Exclude()` + `@ApiHideProperty()` — one mechanism, not two.
