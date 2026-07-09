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
    "is_system" BOOLEAN NOT NULL DEFAULT false,

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
    "scope" TEXT NOT NULL DEFAULT 'platform',

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_members" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "business_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'business',

    CONSTRAINT "business_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_customers" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "business_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "business_customers_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "roles_scope_idx" ON "roles"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "roles_id_scope_key" ON "roles"("id", "scope");

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
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "business_members_user_id_idx" ON "business_members"("user_id");

-- CreateIndex
CREATE INDEX "business_members_business_id_idx" ON "business_members"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_members_business_id_user_id_key" ON "business_members"("business_id", "user_id");

-- CreateIndex
CREATE INDEX "business_customers_user_id_idx" ON "business_customers"("user_id");

-- CreateIndex
CREATE INDEX "business_customers_business_id_idx" ON "business_customers"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_customers_business_id_user_id_key" ON "business_customers"("business_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_user_id_created_at_idx" ON "audit_logs"("target_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "app_versions_platform_release_date_idx" ON "app_versions"("platform", "release_date");

-- CreateIndex
CREATE UNIQUE INDEX "app_versions_platform_version_key" ON "app_versions"("platform", "version");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_scope_fkey" FOREIGN KEY ("role_id", "scope") REFERENCES "roles"("id", "scope") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_role_id_scope_fkey" FOREIGN KEY ("role_id", "scope") REFERENCES "roles"("id", "scope") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_customers" ADD CONSTRAINT "business_customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_customers" ADD CONSTRAINT "business_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────
-- Constraints Prisma cannot express in schema.prisma.
--
-- Everything above is generated by `prisma migrate diff`. Everything below is
-- hand-written and has no `@@`-attribute equivalent, so `prisma migrate dev`
-- will not try to manage it.
--
-- This is the ONLY migration in the template. A starter is a fork in time — a
-- clone begins its own migration history from whatever this file says the day
-- it is cloned — so squash schema changes back into it rather than accreting
-- edits nobody made. Once it has been applied to a real environment its
-- checksum is recorded in `_prisma_migrations` and you must add new migrations
-- instead.
--
-- Note every identifier below is unquoted: columns are snake_case (via `@map`),
-- so Postgres' unquoted-identifier folding is a no-op rather than a trap.
-- ─────────────────────────────────────────────────────────────────────────

-- Scope integrity.
--
-- `user_roles.scope` and `business_members.scope` are constant discriminators,
-- not free columns. Pinning each to a literal, combined with the composite
-- foreign keys on (role_id, scope) -> roles(id, scope) that Prisma generated
-- above, makes it a DATABASE ERROR to assign a BUSINESS role platform-wide, or
-- a PLATFORM role inside a business.
--
-- Without the CHECK, the composite FK alone would still permit a row with
-- scope='business' in user_roles pointing at a business role.
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_scope_check CHECK (scope = 'platform');

ALTER TABLE business_members
  ADD CONSTRAINT business_members_scope_check CHECK (scope = 'business');

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
