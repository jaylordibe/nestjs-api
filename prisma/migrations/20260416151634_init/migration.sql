-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "first_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "last_name" TEXT NOT NULL,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "password_changed_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "otp_hash" TEXT,
    "otp_purpose" TEXT,
    "otp_expires_at" TIMESTAMP(3),
    "email_verified_at" TIMESTAMP(3),
    "phone_number" TEXT,
    "phone_number_verified_at" TIMESTAMP(3),
    "gender" TEXT,
    "profile_image_url" TEXT,
    "birthday" DATE,
    "timezone" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "ip_address" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
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

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "description" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "ownership" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_memberships" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "business_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "invited_by" UUID,
    "notes" TEXT,

    CONSTRAINT "business_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_invitations" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "business_id" UUID NOT NULL,
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

    CONSTRAINT "business_invitations_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "app_versions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "platform" TEXT NOT NULL,
    "device_os" TEXT,
    "release_date" TIMESTAMP(3) NOT NULL,
    "download_url" TEXT,
    "force_update" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "app_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "app_platform" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "device_os" TEXT NOT NULL,
    "device_os_version" TEXT NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "roles_scope_idx" ON "roles"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_name_key" ON "permissions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_scope_action_subject_ownership_key" ON "permissions"("scope", "action", "subject", "ownership");

-- CreateIndex
CREATE INDEX "role_permissions_role_id_idx" ON "role_permissions"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "business_memberships_user_id_status_idx" ON "business_memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "business_memberships_business_id_status_idx" ON "business_memberships"("business_id", "status");

-- CreateIndex
CREATE INDEX "business_memberships_role_id_idx" ON "business_memberships"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_memberships_business_id_user_id_key" ON "business_memberships"("business_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_invitations_token_hash_key" ON "business_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "business_invitations_business_id_status_idx" ON "business_invitations"("business_id", "status");

-- CreateIndex
CREATE INDEX "business_invitations_expires_at_idx" ON "business_invitations"("expires_at");

-- CreateIndex
CREATE INDEX "business_invitations_role_id_idx" ON "business_invitations"("role_id");

-- CreateIndex
CREATE INDEX "business_invitations_invited_user_id_idx" ON "business_invitations"("invited_user_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_user_id_created_at_idx" ON "audit_logs"("target_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "app_versions_platform_device_os_release_date_idx" ON "app_versions"("platform", "device_os", "release_date");

-- CreateIndex
CREATE UNIQUE INDEX "app_versions_platform_device_os_version_key" ON "app_versions"("platform", "device_os", "version");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_memberships" ADD CONSTRAINT "business_memberships_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_invitations" ADD CONSTRAINT "business_invitations_invited_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Constraints Prisma cannot express in schema.prisma.
--
-- Everything above is the shape `prisma migrate diff` produces from
-- schema.prisma. Everything below is hand-written and has no `@@`-attribute
-- equivalent, so `prisma migrate dev` will not try to manage it — and, more
-- importantly, will NOT regenerate it if this file is ever rebuilt. Anyone
-- squashing a future schema change back into this migration must carry these
-- blocks across by hand.
--
-- This is the ONLY migration in the template. A starter is a fork in time — a
-- clone begins its own migration history from whatever this file says the day
-- it is cloned — so squash schema changes back into it rather than accreting
-- edits nobody made. Once it has been applied to a real environment its
-- checksum is recorded in `_prisma_migrations`, and you must add NEW migrations
-- instead; re-baselining after that point breaks `migrate deploy` everywhere it
-- has already run.
--
-- Note every identifier below is unquoted: columns are snake_case (via `@map`),
-- so Postgres' unquoted-identifier folding is a no-op rather than a trap.
-- ─────────────────────────────────────────────────────────────────────────

-- Scope integrity is enforced in CODE, not here — deliberately.
--
-- An earlier shape carried a constant `scope` column on each assignment table
-- (`user_roles`, `business_memberships`, `business_invitations`), pinned by a
-- CHECK and paired with a composite FK to `roles(id, scope)`. That is the
-- standard trick for constraining an FK to a subtype, and it worked — but it
-- bought less than it looked like it did.
--
-- It guards the WRITE path only. The escalation that actually matters happens
-- on the READ path: `AbilityFactory` branches on where a grant ARRIVED from,
-- never on what the permission claims to be, so a BUSINESS permission reaching
-- the platform branch compiles to an UNCONDITIONAL rule (business permissions
-- are always `ANY`) — a platform-wide grant with no tenant bound. A database
-- constraint cannot see that, and cannot see a stale or corrupted grant set
-- arriving from the Redis cache either.
--
-- So the guarantee moved to `AbilityFactory`, which refuses to compile any
-- permission whose scope does not match the branch it arrived in. One place,
-- both directions, after the cache, covering strictly more than three CHECKs
-- did — and the schema loses three never-varying columns plus a unique index
-- that existed solely to be a foreign-key target.
--
-- The write path still validates: `UserRolesService.loadPlatformRole` and
-- `loadAssignableBusinessRole` in both business services.

-- Soft-delete-aware uniqueness.
--
-- A plain UNIQUE index lets a soft-deleted row hold its identifier hostage
-- forever: delete a user, and their email can never be reused; delete a
-- business, and its slug is gone for good. Restricting the index to live rows
-- is the standard fix.
--
-- Prisma cannot express a partial unique index, which is why `User.email`,
-- `User.username`, and `Business.slug` deliberately carry no `@unique` in
-- schema.prisma. Look them up with `findFirst`, never `findUnique`.
--
-- Do NOT "fix" that with a composite `@@unique([email, deletedAt])`: in SQL
-- NULL != NULL, so Postgres would accept two LIVE rows with the same email
-- while still reporting the index as unique.
CREATE UNIQUE INDEX users_email_key
  ON users (email)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX users_username_key
  ON users (username)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX businesses_slug_key
  ON businesses (slug)
  WHERE deleted_at IS NULL;

-- One OUTSTANDING invitation per (business, email).
--
-- Partial rather than total, for the same reason as the indexes above: an
-- accepted or revoked invitation is history and must not stop the business from
-- inviting that address again. Restricting the index to `pending` also makes
-- the race safe — two concurrent invites to one address collide here rather
-- than both succeeding.
--
-- Prisma cannot see this, so `BusinessInvitation` carries no `@@unique` on
-- (business_id, email): look a pending invitation up with `findFirst`.
CREATE UNIQUE INDEX business_invitations_business_id_email_pending_key
  ON business_invitations (business_id, email)
  WHERE status = 'pending';

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
