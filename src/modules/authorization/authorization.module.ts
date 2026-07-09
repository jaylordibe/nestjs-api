import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AbilityScopedQueryService } from './ability-scoped-query.service';
import { AbilityFactory } from './ability.factory';
import { PermissionCatalogIntegrityService } from './permission-catalog-integrity.service';
import { PermissionCheckService } from './permission-check.service';
import { PermissionLoaderService } from './permission-loader.service';
import { RouteAuthorizationAuditService } from './route-authorization-audit.service';

// @Global, like PrismaModule / RedisModule / AuditModule: the guard and every
// feature service needs the ability layer, and threading an import through
// every module would be noise.
//
// PrismaModule and RedisModule are themselves @Global, so nothing to import
// beyond DiscoveryModule (which RouteAuthorizationAuditService uses to walk
// controller metadata at boot).
//
// Two of the providers here are startup gates that THROW: the app will not
// boot with a drifted permission catalog, nor with a route handler that
// declares no authorization decision.
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    AbilityFactory,
    AbilityScopedQueryService,
    PermissionLoaderService,
    PermissionCheckService,
    PermissionCatalogIntegrityService,
    RouteAuthorizationAuditService,
  ],
  exports: [
    AbilityFactory,
    AbilityScopedQueryService,
    PermissionLoaderService,
    PermissionCheckService,
  ],
})
export class AuthorizationModule {}
