# Schema and lifecycle reference

## Standard field ordering

Use the repository's schema conventions, including snake_case mappings:

```prisma
model Order {
  id        String   @id @default(uuid()) @db.Uuid

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  createdBy String?  @db.Uuid @map("created_by")
  updatedBy String?  @db.Uuid @map("updated_by")

  deletedAt DateTime? @map("deleted_at")
  deletedBy String?   @db.Uuid @map("deleted_by")

  isActive Boolean @default(true) @map("is_active")

  // Domain fields and relations

  @@map("orders")
}
```

Only include optional lifecycle/state fields when the model needs them.

Always-required audit columns follow the established project model policy.
Inspect neighboring models before copying a generic block.

## Boolean naming

Every Boolean reads as a predicate:

- `isActive`
- `isEnabled`
- `isVerified`

Do not use bare `active`, `enabled`, or `verified`.

## Enum-like values

Current project policy stores enum-like values as strings and constrains them
through TypeScript enums and DTO `@IsEnum`.

Use:

- UPPER_SNAKE enum keys;
- lowercase_snake values;
- explicit cast at the DB-to-application boundary where required.

Do not introduce a PostgreSQL enum without an approved plan changing policy.

## Lifecycle decisions

### Hard delete

Appropriate for transient operational records where:

- no retention or restoration value exists;
- uniqueness must be released;
- cascade behavior is intentional;
- historical records do not need the row.

### Soft delete

Appropriate where:

- historical relations must remain valid;
- accidental deletion must be reversible;
- retention/audit requires the row;
- ownership at event time matters.

Use the full `deletedAt` + `deletedBy` pair and register the model in the
soft-delete mechanism.

### Suspension

`isActive` is a business state, not a deletion substitute.

Use it only when the resource has a real independently reversible suspension
state.

### Erasure/anonymization

Soft deletion still retains PII.

A true erasure flow must deliberately overwrite/remove identifying fields,
invalidate credentials/tokens, preserve required foreign-key history, and
record the security/audit event.

## Soft-delete reads

`prisma.scoped` filters top-level reads for registered soft-delete models.

It does not automatically filter nested relation includes:

- to-many relation: add `where: { deletedAt: null }`;
- to-one relation: constrain the parent/query because Prisma has no relation
  `where` on a to-one include.

Use raw `prisma.*` only for an explicit administrative, forensic, recovery, or
retention path.

Soft deletion never replaces ability/tenant scoping.

## Live-row uniqueness

A normal unique constraint lets a soft-deleted row retain the identifier.

For fields unique only among live rows:

- use a PostgreSQL partial unique index with
  `WHERE deleted_at IS NULL`;
- do not add Prisma `@unique` for that field;
- do not use `@@unique([field, deletedAt])`;
- use `findFirst`, not `findUnique`, because Prisma cannot represent the partial
  index as a unique selector.

Add conflict and re-use-after-delete tests.
