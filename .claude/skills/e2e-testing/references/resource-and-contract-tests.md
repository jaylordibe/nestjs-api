# Resource and contract e2e checklist

For a normal five-endpoint resource, cover the behavior that actually exists:

- create;
- find paginated;
- find by ID;
- update;
- delete;
- unauthenticated access;
- insufficient permission;
- ownership/tenant boundaries;
- pagination metadata and deterministic order;
- invalid pagination/filter/sort input;
- not-found behavior;
- stable error envelope and `errorCode`;
- response DTO serialization;
- audit/lifecycle persistence through direct DB assertions;
- soft-delete or hard-delete semantics;
- uniqueness and conflict behavior;
- Swagger/consumer-sensitive shape where testable.

Do not blindly add every case to every resource. Map tests to accepted behavior
and risk.

## Shared principals

Use shared fixtures:

- seed the RBAC catalog after truncation;
- create platform admin/support/regular users through helpers;
- create business memberships through established helpers;
- use register/login helpers only when the auth flow itself is under test.

There is no authoritative `role` field on `users`. Do not fabricate one in
fixtures.

## Errors

Assert `errorCode`, status, and meaningful `details`.

Examples of stable categories may include:

- validation failure;
- invalid credentials;
- insufficient permission;
- resource not found;
- unique constraint conflict.

Read the error README rather than copying a stale code list.

## Audit fields

Fields such as `createdBy`, `updatedBy`, `deletedAt`, and `deletedBy` are not API
contract fields.

Read them through `PrismaService` and separately assert that the response omits
them.
