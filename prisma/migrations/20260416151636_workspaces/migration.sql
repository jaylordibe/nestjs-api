-- `workspaces`. Tenants.
-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- ── Constraints Prisma cannot express ───────────────────────────────────────
-- Soft-delete-aware uniqueness for the slug; the reasoning is in the users
-- migration. Look a workspace up by slug with `findFirst`, never `findUnique`.
CREATE UNIQUE INDEX workspaces_slug_key
  ON workspaces (slug)
  WHERE deleted_at IS NULL;
