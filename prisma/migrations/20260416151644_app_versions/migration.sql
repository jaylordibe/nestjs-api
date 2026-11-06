-- `app_versions`. Client release trains and their versions.
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
    "is_force_update" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "app_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_versions_platform_device_os_release_date_idx" ON "app_versions"("platform", "device_os", "release_date");

-- CreateIndex
CREATE UNIQUE INDEX "app_versions_platform_device_os_version_key" ON "app_versions"("platform", "device_os", "version");
