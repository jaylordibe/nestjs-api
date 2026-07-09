import { Module } from '@nestjs/common';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { UserRolesController } from './user-roles.controller';
import { UserRolesService } from './user-roles.service';

// Three resources, one bounded context: roles are DATA (operators create them),
// permissions are CODE (projected from the catalog, read-only), and `user_roles`
// is the PLATFORM-scope assignment between a user and a role. Business-scope
// assignment lives in BusinessesModule, on `business_members`.
@Module({
  controllers: [RolesController, PermissionsController, UserRolesController],
  providers: [RolesService, PermissionsService, UserRolesService],
  exports: [RolesService, PermissionsService, UserRolesService],
})
export class RolesModule {}
