import { Injectable } from '@nestjs/common';
import {
  taggedSubject,
  type AppAbility,
} from '../../common/authorization/app-ability';
import type {
  AuthorizationAction,
  AuthorizationSubject,
} from '../../common/authorization/permission-catalog';
import { Errors } from '../../common/errors/errors';
import { AbilityFactory } from './ability.factory';
import { PermissionLoaderService } from './permission-loader.service';

@Injectable()
export class PermissionCheckService {
  constructor(
    private readonly abilityFactory: AbilityFactory,
    private readonly permissionLoaderService: PermissionLoaderService,
  ) {}

  // Builds an ability outside an HTTP request (cron jobs, scripts, service-to-
  // service work). Inside a request, prefer the `@CurrentAbility()` decorator:
  // the guard has already built it, so re-deriving it costs a Redis round trip
  // for nothing.
  async createAbilityForUser(userId: string): Promise<AppAbility> {
    const grants = await this.permissionLoaderService.loadGrants(userId);
    return this.abilityFactory.createForUser(userId, grants);
  }

  // Instance-level check against a record that has already been loaded.
  //
  // Reach for this ONLY where `accessibleBy` cannot express the rule as a
  // `where` clause — i.e. derived ownership that requires a join ("I may edit
  // this booking because I own the business that owns it"). Load the parent,
  // then assert against it.
  //
  // For ordinary tenant-scoped reads use AbilityScopedQueryService instead: it
  // filters in the query, so a cross-tenant row is never loaded and the caller
  // gets a 404 rather than a 403 that would confirm the record exists.
  assertCan(
    ability: AppAbility,
    action: AuthorizationAction,
    subjectType: AuthorizationSubject,
    record: Record<string, unknown>,
  ): void {
    // Prisma rows are plain objects with no class identity, so CASL cannot
    // infer the subject type from the value. `subject()` tags it explicitly —
    // preferable to stamping `__caslSubjectType__` onto rows that get
    // serialized into responses.
    if (ability.cannot(action, taggedSubject(subjectType, record))) {
      throw Errors.permissionDenied(action, subjectType);
    }
  }
}
