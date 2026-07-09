# Authorization contract (RBAC + CASL)

This is the companion to `src/common/errors/README.md`. Read it before touching
anything under `src/modules/authorization/` or any `@RequirePermission`
decorator.

---

## The model in one paragraph

A **permission** is a tuple `(action, subject, scope, ownership)` defined once
in [`permission-catalog.ts`](./permission-catalog.ts). A **role** is a named
bundle of permissions. A user holds PLATFORM roles through `user_roles`, and
BUSINESS roles through `business_members` — one row per business. On every
request, `PermissionsGuard` loads the caller's grants (Redis-cached, DB-backed)
and compiles them into a single CASL `Ability`. Handlers declare what they need;
queries enforce which rows the caller may touch.

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

Without it, `PLATFORM_USER`'s `update User (own)` would pass the guard on
`PATCH /users/:id` — a rule *does* exist, and the guard cannot see its
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

## Adding a custom role at runtime

`POST /roles` — permissions must share the role's scope, and `rank` is capped at
99 so a custom role can never outrank `PLATFORM_ADMIN` / `BUSINESS_OWNER` and
slip past the escalation guard.

---

## The escalation guard

`assignRole` is a permission distinct from `update`, because CASL's `manage`
wildcard would otherwise swallow it — and `manage BusinessMember` would let a
`BUSINESS_ADMIN` promote itself to owner.

On top of the permission, `rank` bounds it:

> You may grant, or act upon, a role **at or below** your own rank — never one
> above it.

At-or-below is deliberate. A lateral grant is not an escalation (a
`BUSINESS_ADMIN` minting a peer admin gains nothing it lacked), and
strictly-below would make appointing a co-owner impossible — which would in turn
make the last-owner invariant's advice ("promote another member first")
unreachable.

`rank` orders roles **for this check only**. It does *not* imply inherited
permissions. `BUSINESS_ADMIN` does not contain `BUSINESS_STAFF`; every role's
grants are listed explicitly. Conflating "outranks" with "inherits" is how RBAC
systems rot.

---

## Caching and invalidation

Grants (not abilities — CASL rules don't round-trip through JSON) are cached in
Redis under `authz:v1:grants:{epoch}:{userId}`.

| change | invalidation |
|---|---|
| user's roles or memberships change | `DEL` that one key |
| a **role's** permission set changes | `INCR authz:epoch` — retires every cached grant at once |

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

## Deliberate non-goals

**No pending-invitation flow.** Adding a business member requires an existing
account. To add invitations: a `business_invitations` table (email, businessId,
roleId, token hash, expiry), an emailed token via the existing `EmailService`,
and an accept endpoint that creates the `business_members` row. Deliberately out
of the baseline because it is product surface, not authorization infrastructure.

**No `BUSINESS_CUSTOMER` role.** A customer of a business is a *relationship*,
not authority over it. Everything a customer does — book, view, cancel — acts on
their **own** records, which `own`-scoped permissions already express. Modelling
customers as `business_members` rows would (a) collide with
`@@unique([businessId, userId])`, so a staff member could never be a customer of
their own business; (b) mix a ten-row staff roster with a hundred-thousand-row
customer list; and (c) drag every customer relationship into the ability graph.

Customers are their own resource: **`business_customers`** (see
`src/modules/businesses/customers/`). It is the first subject registered in
**both** key maps:

```ts
SUBJECT_OWNER_KEY  = { …, BusinessCustomer: 'userId'     }  // the customer's own record
SUBJECT_TENANT_KEY = { …, BusinessCustomer: 'businessId' }  // the business's customer list
```

The two rules OR-compose, so one endpoint serves both audiences: `GET
/businesses/:businessId/customers` returns a customer's single row, a staff
member's whole tenant, and everything to a platform admin — with no branching in
the service.

Because the subject is ownable *and* tenant-scoped, `PermissionsGuard` checks a
stub carrying **both** keys (`{ businessId, userId: caller }`) — see
`buildTenantStub`. Supplying only the tenant key would silently deny a customer
whose rule is conditioned on `userId`. Acting on *someone else's* record is
re-checked in the service against the resolved target id, which is why a
customer cannot enrol a third party even though they pass the guard.

Customers log in through the ordinary `/auth/login`: a customer **is** a `User`
with `PLATFORM_USER`. One account, many businesses — and a stylist can be a
customer of the salon they work at.

**No role hierarchy.** See the escalation guard above.

**No per-user permission overrides.** Permissions flow only through roles.

**No field-level CASL rules.** Response redaction stays with Response DTOs +
`@Exclude()` + `@ApiHideProperty()` — one mechanism, not two.
