# Architecture standard — project edition

`CLAUDE.md` and accepted ADRs are authoritative. This file provides deeper
interpretive guidance and must not weaken repository-specific rules.

## Priorities

1. correctness and data integrity;
2. security and privacy;
3. compatibility and operability;
4. maintainability and testability;
5. performance and cost;
6. delivery speed.

## Boundaries

- `src/common` is a dependency leaf.
- Pure metadata/decorators/utilities may live in common; anything requiring a
  service belongs in a module.
- Domain/application behavior does not belong in controllers or DTOs.
- Persistence models are not API models.
- Permissions have one catalog source of truth.
- Tenant visibility belongs in the query through the authorization module.
- Error behavior has one factory/filter contract.
- Config has one typed source.
- Provider and queue abstractions remain centralized.

## Coherent scope

Prefer the smallest coherent complete change.

Do not:

- leave half-migrated in-scope call sites;
- create parallel legacy/new paths;
- add speculative abstractions;
- hide unrelated refactors inside a feature.

## Contracts

Treat as externally observable:

- request/response DTOs;
- required/optional/null fields;
- enum values;
- `errorCode`;
- HTTP status;
- pagination/order;
- webhook/event payloads;
- idempotency/retry behavior;
- Swagger schemas.

Every change identifies consumers, deployment order, mixed-version behavior,
deprecation, and rollback/roll-forward.

## State and distributed behavior

Explicitly model:

- lifecycle transitions;
- invalid transitions;
- transaction boundaries;
- concurrency and lost-update prevention;
- delivery semantics;
- idempotency;
- duplicate and poison-message behavior;
- retryable versus terminal errors;
- timeouts and cancellation;
- correlation and reconciliation.

Never claim exactly-once or gapless business sequencing without a proven bounded
mechanism.

## Data evolution

Follow repository migration policy and, for deployed systems, expand/migrate/
contract.

Address existing data, indexes, locks, backfills, mixed versions, abort
thresholds, and recovery.

## ADRs

A material decision records context, ticket-vs-code reconciliation, alternatives,
security, file plan, tests, verification, migration, rollout, non-goals, and
human approval.
