-- `workspace_invitations`. Outstanding offers to join a workspace.
-- CreateTable
CREATE TABLE "workspace_invitations" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "workspace_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "invited_user_id" UUID,
    "role_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invited_by" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "accepted_by" UUID,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" UUID,

    CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invitations_token_hash_key" ON "workspace_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "workspace_invitations_workspace_id_status_idx" ON "workspace_invitations"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "workspace_invitations_expires_at_idx" ON "workspace_invitations"("expires_at");

-- CreateIndex
CREATE INDEX "workspace_invitations_role_id_idx" ON "workspace_invitations"("role_id");

-- CreateIndex
CREATE INDEX "workspace_invitations_invited_user_id_idx" ON "workspace_invitations"("invited_user_id");

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Constraints Prisma cannot express ───────────────────────────────────────
-- One OUTSTANDING invitation per (workspace, email).
--
-- Partial rather than total, for the same reason as the soft-delete indexes in
-- the users migration: an accepted or revoked invitation is history and must not
-- stop the workspace from inviting that address again. Restricting the index to
-- `pending` also makes the race safe — two concurrent invites to one address
-- collide here rather than both succeeding.
--
-- Prisma cannot see this, so `WorkspaceInvitation` carries no `@@unique` on
-- (workspace_id, email): look a pending invitation up with `findFirst`.
CREATE UNIQUE INDEX workspace_invitations_workspace_id_email_pending_key
  ON workspace_invitations (workspace_id, email)
  WHERE status = 'pending';
