# Database design: [Change]

- **Related ADR/ticket:**
- **Owner:**
- **Prisma version:** 7
- **Database:** PostgreSQL
- **Risk:** Low | Medium | High | Critical

## Model lifecycle

| Model | Owner/context | Soft/hard delete | User-facing access | Tenant/ownership |
|---|---|---|---|---|
| | | | `prisma.scoped`/raw | |

## Schema

| Prisma field | PostgreSQL column | Type | Null/default | Invariant | Sensitive |
|---|---|---|---|---|---|
| | | | | | |

- `@@map` table:
- `@map` fields:
- `is` boolean naming:
- TypeScript enum/string policy:

## Constraints and indexes

| Invariant/query | Constraint/index | Partial predicate | Prisma selector implication |
|---|---|---|---|
| | | `deleted_at IS NULL` | `findFirst`/`findUnique` |

Do not model live-row uniqueness as `@@unique([field, deletedAt])`.

## Query and authorization

- `AbilityScopedQueryService` method:
- tenant/ownership predicates:
- soft-delete top-level behavior:
- nested to-many filtering:
- to-one parent filtering:
- pagination/order:
- N+1 risk:
- index support:

## Transactions and concurrency

- invariant boundary:
- transaction:
- isolation/lock/version:
- lost-update prevention:
- duplicate/idempotency:
- sequence/counter semantics:
- deadlock/retry behavior:

## Migration

- existing deployed migration state:
- consolidated migration filename:
- raw SQL required:
- expand:
- app rollout:
- bounded/resumable backfill:
- constraints/indexes:
- contract/removal:
- mixed-version behavior:
- lock/downtime/storage risk:
- abort threshold:
- rollback/roll-forward:

Do not apply to local dev DB. Test execution belongs to the isolated e2e DB
harness.

## Verification

- `yarn build` generated shape:
- SQL review:
- clean test DB:
- representative existing data:
- partial uniqueness:
- soft-delete visibility:
- tenant isolation:
- concurrency:
- query plan/performance:
- reconciliation:
