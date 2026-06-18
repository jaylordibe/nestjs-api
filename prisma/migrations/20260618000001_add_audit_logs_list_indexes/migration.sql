-- Three indexes on `audit_logs`, all targeting the common admin
-- list-page access patterns. Idempotent (`IF NOT EXISTS`) so re-applying
-- against a partial state is safe.
--
-- 1. `audit_logs_metadata_trgm_idx` — pg_trgm GIN index on
--    `(metadata::text)` to accelerate substring search across the
--    serialized JSON. Without this, `metadata::text ILIKE '%term%'`
--    falls back to a sequential scan over every audit row — fine for
--    hundreds of rows, painful past tens of thousands.
--
--    We index `(metadata::text)` rather than `metadata` directly: the
--    standard `jsonb_ops` / `jsonb_path_ops` GIN classes support `@>` / `?`
--    containment queries, NOT arbitrary substring search across nested keys.
--    Coercing to text first lets pg_trgm treat the whole serialized JSON as
--    one searchable string.
--
--    Prisma can't natively express trigram operator classes in
--    schema.prisma, so this index is managed via raw SQL — no @@index
--    declaration on AuditLog for it.
--
-- 2. `audit_logs_action_createdAt_idx` — composite B-tree. Speeds up the
--    `?action=foo` filter combined with the default `ORDER BY createdAt
--    DESC`. Mirrors the existing (actorId, createdAt) shape.
--
-- 3. `audit_logs_createdAt_idx` — single-column B-tree on `createdAt` for
--    pure date-range queries with no actor / target / action filter. The
--    composite indexes can't serve those (their leading column isn't
--    createdAt).
--
-- Indexes 2 and 3 are also declared as @@index in schema.prisma so Prisma's
-- diff doesn't try to re-create them.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "audit_logs_metadata_trgm_idx"
  ON "audit_logs"
  USING gin ((metadata::text) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "audit_logs_action_createdAt_idx"
  ON "audit_logs" ("action", "createdAt");

CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx"
  ON "audit_logs" ("createdAt");
