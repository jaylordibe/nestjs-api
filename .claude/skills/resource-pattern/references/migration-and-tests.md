# Migration and test reference

## Migration preparation

First determine whether any deployed environment has applied the repository's
migration history.

### No deployed environment has applied migrations

The starter's initial migration may be consolidated to represent the final
schema for the current work batch.

### A deployed environment has applied migrations

Do not edit checksummed applied files. Add one new coherent migration for the
accepted change.

### In both cases

- do not apply migrations to the local development DB;
- do not run reset, drop, re-seed, or `db push`;
- prepare raw SQL when Prisma cannot express partial indexes or other required
  constructs;
- consolidate multi-step work into the correct single migration for the batch;
- use `yarn build` to verify generated Prisma types and application compilation;
- let the isolated e2e test harness exercise migrations on the test DB;
- let the human apply the finalized migration to local/shared/production
  environments.

Analyze:

- existing rows;
- nullability/default transition;
- backfill bounds and resumability;
- FK/unique/index conflicts;
- lock/downtime;
- deployment order and mixed versions;
- rollback or roll-forward;
- reconciliation/repair.

## Resource e2e coverage

Map tests to the actual accepted resource contract.

Normally cover:

- create;
- find paginated;
- find by ID;
- update;
- delete;
- unauthenticated;
- insufficient permission;
- owner/tenant visibility;
- 404 versus 403;
- validation and unknown fields;
- pagination/search/filter/sort;
- stable error codes;
- response DTO/secret exclusion;
- audit columns through DB reads;
- chosen delete lifecycle;
- uniqueness, including live-row partial uniqueness;
- transaction/concurrency behavior;
- relevant relation serialization.

Use `e2e-testing` for harness, queue, Redis, and cadence rules.
