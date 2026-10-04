# Schema and lifecycle reference

Naming (`@map` to snake_case, `is*` booleans, no DB enums), partial uniqueness,
and soft-delete read semantics are owned by `docs/engineering-conventions.md`.
The soft-delete mechanism is owned by `src/prisma/prisma-soft-delete.extension.ts`.
This file holds the field order and the lifecycle choice.

## Standard field ordering

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

Only include optional lifecycle/state fields when the model needs them. Inspect
neighboring models before copying a generic block.

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

Use the full `deletedAt` + `deletedBy` pair and add the model to
`SOFT_DELETE_MODELS` in `src/prisma/prisma-soft-delete.extension.ts`.

### Suspension

`isActive` is a domain state, not a deletion substitute. Use it only when the
resource has a real, independently reversible suspension state.

### Erasure/anonymization

Soft deletion still retains PII. A true erasure flow must deliberately
overwrite or remove identifying fields, invalidate credentials and tokens,
preserve required foreign-key history, and record the security/audit event.
