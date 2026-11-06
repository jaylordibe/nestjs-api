-- `users`. Accounts.
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
    "otp_hash" TEXT,
    "otp_purpose" TEXT,
    "otp_expires_at" TIMESTAMP(3),
    "email_verified_at" TIMESTAMP(3),
    "phone_number" TEXT,
    "phone_number_verified_at" TIMESTAMP(3),
    "gender" TEXT,
    "profile_image_file_asset_id" UUID,
    "birthday" DATE,
    "timezone" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_profile_image_file_asset_id_key" ON "users"("profile_image_file_asset_id");

-- ── Constraints Prisma cannot express ───────────────────────────────────────
-- Hand-written: `prisma migrate diff` neither produces nor regenerates these, so
-- anyone folding a schema change into this file carries them across by hand.
-- Identifiers are unquoted: columns are snake_case (via `@map`), so Postgres'
-- unquoted-identifier folding is a no-op rather than a trap.

-- Soft-delete-aware uniqueness.
--
-- A plain UNIQUE index lets a soft-deleted row hold its identifier hostage
-- forever: delete a user, and their email can never be reused; delete a
-- workspace, and its slug is gone for good. Restricting the index to live rows
-- is the standard fix (`workspaces.slug` gets the same index in its migration).
--
-- Prisma cannot express a partial unique index, which is why `User.email`,
-- `User.username`, and `Workspace.slug` deliberately carry no `@unique` in
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
