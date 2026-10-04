---
name: authorization
description: This repository's answers for RBAC and CASL — the permission catalog as source of truth, the one access decorator every route declares, AbilityScopedQueryService as the only query-scoping path, the 404-versus-403 rule, escalation rank, and grants-cache invalidation.
when_to_use: Use when adding or changing permissions, roles, workspace-scoped resources, @RequirePermission, @AuthenticatedOnly, @Public, AbilityScopedQueryService, permission catalogs, ownership rules, administrative routes, role assignment, or authorization tests.
user-invocable: false
---

# Authorization: RBAC + CASL — this repository's answers

The `himoa:domain-authorization` skill carries the questions and failure modes
of any authorization change. **`src/common/authorization/README.md` is this
repository's contract** — read it first; this skill restates none of it. The
one-line rules are in `AGENTS.md` (Authorization, Tenant isolation).

| You are… | README section |
|---|---|
| declaring access on a handler | Declaring authorization on a handler (incl. `administrative`, `denyAsNotFound`) |
| choosing 404 or 403 | 404 vs 403 — the rule; `PermissionCheckService` |
| composing a scoped query | The Prisma empty-`OR` landmine |
| adding a permission | Adding a permission |
| adding a tenant- or owner-scoped model | Adding a workspace-scoped model; Adding an owner-scoped model |
| changing roles, rank or assignment | Roles are code; The escalation guard |
| changing a grant or membership | Caching and invalidation |
| changing memberships or invitations | One membership per person per workspace; Invitations |

Also read `permission-catalog.ts`, `src/modules/authorization/**` and the
authorization e2e specs. Privileged actions are audited per
`docs/engineering-conventions.md` (Audit log + request envelope).

## Required tests

Use the `e2e-testing` skill for the harness. Cover, as relevant:

- 401 unauthenticated; no grant; correct grant;
- owner versus non-owner; same-workspace versus cross-workspace;
- PLATFORM versus WORKSPACE scope;
- invisible record → 404; visible but forbidden action → 403;
- an administrative route not unlocked by an own-only permission;
- dual-scoped owner/staff behavior;
- escalation and rank denial;
- grants-cache invalidation;
- permission catalog integrity (`yarn rbac:check`);
- stable `errorCode`, never message text.
