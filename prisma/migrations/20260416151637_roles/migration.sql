-- `roles`. Roles: a projection of `src/common/authorization/permission-catalog.ts`.
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

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE INDEX "roles_scope_idx" ON "roles"("scope");
