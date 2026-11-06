-- `audit_logs`. The audit trail.
-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "target_user_id" UUID,
    "action" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_user_id_created_at_idx" ON "audit_logs"("target_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- ── Constraints Prisma cannot express ───────────────────────────────────────
-- Trigram index for substring search across the audit-log metadata envelope.
--
-- `GET /audit-logs?search=…` matches `metadata::text ILIKE '%term%'`. Without
-- this index that is a sequential scan over every audit row — fine for hundreds,
-- painful past tens of thousands.
--
-- Indexed on `(metadata::text)` rather than on `metadata` directly: the standard
-- `jsonb_ops` / `jsonb_path_ops` GIN classes serve containment (`@>`, `?`), NOT
-- arbitrary substring search across nested keys. Coercing to text first lets
-- pg_trgm treat the whole serialized JSON as one searchable string.
--
-- Prisma cannot express trigram operator classes, so `AuditLog` carries no
-- `@@index` for this one. The other audit-log indexes — (actor_id, created_at),
-- (target_user_id, created_at), (action, created_at), (created_at) — ARE declared
-- in schema.prisma and are generated above.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX audit_logs_metadata_trgm_idx
  ON audit_logs
  USING gin ((metadata::text) gin_trgm_ops);
