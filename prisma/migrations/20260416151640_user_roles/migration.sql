-- `user_roles`. PLATFORM-scope role assignments.
-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Scope integrity is enforced in CODE, not here — deliberately. This holds for
-- every role-assignment table: `user_roles`, `workspace_memberships` and
-- `workspace_invitations`.
--
-- An earlier shape carried a constant `scope` column on each assignment table,
-- pinned by a CHECK and paired with a composite FK to `roles(id, scope)`. That
-- is the standard trick for constraining an FK to a subtype, and it worked —
-- but it bought less than it looked like it did.
--
-- It guards the WRITE path only. The escalation that actually matters happens
-- on the READ path: `AbilityFactory` branches on where a grant ARRIVED from,
-- never on what the permission claims to be, so a WORKSPACE permission reaching
-- the platform branch compiles to an UNCONDITIONAL rule (workspace permissions
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
-- `WorkspaceRoleAssignmentPolicy.loadAssignableRole`.
