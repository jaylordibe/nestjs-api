-- Stored files (`file_assets`) and the user's profile image as a reference to one.
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "profile_image_file_id" UUID;

-- CreateTable
CREATE TABLE "file_assets" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "storage_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "file_name" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "attached_at" TIMESTAMP(3),
    "delete_attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "file_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_assets_storage_key_key" ON "file_assets"("storage_key");

-- CreateIndex
CREATE INDEX "file_assets_status_expires_at_idx" ON "file_assets"("status", "expires_at");

-- CreateIndex
CREATE INDEX "file_assets_uploaded_by_status_idx" ON "file_assets"("uploaded_by", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_profile_image_file_id_key" ON "users"("profile_image_file_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_profile_image_file_id_fkey" FOREIGN KEY ("profile_image_file_id") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Invariants Prisma cannot express ─────────────────────────────────────────
-- Only rules between columns or ranges; allowed values (status, purpose, kind)
-- live in TS enums so a new one needs no migration.

-- `expires_at` is set exactly while a file is `ready`: it is the moment an
-- unattached file stops being attachable, and meaningless in any other state.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_expires_at_when_ready_check"
    CHECK (("status" = 'ready') = ("expires_at" IS NOT NULL));

ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_size_bytes_check"
    CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0);

ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_delete_attempts_check"
    CHECK ("delete_attempts" >= 0);

-- A file's dimensions: both or neither (a document has none), and never zero.
-- Every image the processor writes has both, so this only refuses a defect.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_dimensions_check"
    CHECK (("width" IS NULL) = ("height" IS NULL) AND ("width" IS NULL OR ("width" > 0 AND "height" > 0)));
