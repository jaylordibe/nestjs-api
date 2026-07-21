import { Injectable } from '@nestjs/common';
import { accessibleBy } from '@casl/prisma';
import type { Prisma } from '@prisma/client';
import type { AppAbility } from '../../common/authorization/app-ability';
import type { AuthorizationAction } from '../../common/authorization/permission-catalog';
import { Errors } from '../../common/errors/errors';

// Prisma `WhereInput` for each subject a query can be scoped by. `all` is
// excluded: it is a CASL wildcard, not a table.
export interface WhereInputBySubject {
  User: Prisma.UserWhereInput;
  Business: Prisma.BusinessWhereInput;
  BusinessMember: Prisma.BusinessMemberWhereInput;
  BusinessCustomer: Prisma.BusinessCustomerWhereInput;
  Role: Prisma.RoleWhereInput;
  Permission: Prisma.PermissionWhereInput;
  AppVersion: Prisma.AppVersionWhereInput;
  DeviceToken: Prisma.DeviceTokenWhereInput;
  AuditLog: Prisma.AuditLogWhereInput;
}

export type ScopableSubject = keyof WhereInputBySubject;

// An `accessibleBy` fragment is either `{}` (unrestricted — `manage all`) or
// `{ OR: [...] }`. Typed loosely because CASL builds it dynamically.
interface AccessibleFragment {
  OR?: unknown[];
}

/**
 * Turns a caller's ability into a Prisma `where` clause.
 *
 * This is the ONLY place in the codebase permitted to call `accessibleBy`.
 * An ESLint rule forbids importing `@casl/prisma` anywhere else, because the
 * composition below is easy to get catastrophically wrong — see the landmine.
 *
 * Row-level and tenant scoping live HERE, in the query, not in a guard. A
 * guard runs before the record is loaded, so it can only ask whether a rule
 * exists; it cannot evaluate that rule's conditions. Filtering in the query
 * means a record the caller may not see is never loaded, so the caller gets a
 * 404 rather than a 403 — which is also correct, since a 403 would confirm the
 * record exists.
 */
@Injectable()
export class AbilityScopedQueryService {
  /**
   * The `where` clause selecting exactly the rows this ability may `action`.
   *
   * ⚠️ THE COMPOSITION SHAPE IS LOAD-BEARING. Verified against Prisma 7 +
   * Postgres 16:
   *
   *   { OR: [] }                        → WHERE 1=0   ✅ matches nothing
   *   { id, OR: [] }                    → WHERE 1=0   ✅ matches nothing
   *   { AND: [{ id }, { OR: [] }] }     → WHERE id=…  🚨 empty OR DROPPED
   *   { AND: [{ OR: [] }] }             → WHERE 1=1   🚨 returns EVERY ROW
   *
   * Prisma silently discards an empty `OR: []` when it appears as an element
   * of an `AND` array, at any depth. So the obvious merge —
   * `{ AND: [callerWhere, fragment] }` — is a total authorization bypass for
   * any caller holding no rules on the subject.
   *
   * The fragment is therefore SPREAD AT THE TOP LEVEL and the caller's filter
   * goes under `AND`. Do not "simplify" this. `ability-scoped-query.service.spec.ts`
   * asserts the emitted shape so a refactor fails the build instead of quietly
   * opening the boundary.
   */
  buildWhere<TSubject extends ScopableSubject>(
    ability: AppAbility,
    action: AuthorizationAction,
    subject: TSubject,
    callerWhere: WhereInputBySubject[TSubject] = {},
  ): WhereInputBySubject[TSubject] {
    // Fail closed #1: no rule grants this action on this subject at all.
    if (ability.cannot(action, subject)) {
      throw Errors.permissionDenied(action, subject);
    }

    const fragment = accessibleBy(ability, action).ofType(
      subject,
    ) as AccessibleFragment;

    // Fail closed #2: belt and braces. `{ OR: [] }` means "no rules matched",
    // and we must never hand that to Prisma inside an `AND`. Independent of
    // Prisma's version-specific handling of the empty array.
    if (Array.isArray(fragment.OR) && fragment.OR.length === 0) {
      throw Errors.permissionDenied(action, subject);
    }

    return {
      ...fragment,
      AND: [callerWhere],
    } as WhereInputBySubject[TSubject];
  }

  /**
   * `buildWhere` for endpoints marked `@RequirePermission(..., { denyAsNotFound: true })`:
   * holding no grant yields a filter that matches nothing, rather than a 403.
   * A list returns `200 []`; a record lookup returns 404.
   *
   * The empty-set filter is `{ id: { in: [] } }`, NOT `{ OR: [] }`. Both
   * compile to `WHERE 1=0` on their own, but Prisma drops an empty `OR` when
   * it sits inside an `AND` array, whereas `id: { in: [] }` survives at any
   * depth. Verified against Prisma 7 + Postgres 16.
   */
  buildWhereOrEmpty<TSubject extends ScopableSubject>(
    ability: AppAbility,
    action: AuthorizationAction,
    subject: TSubject,
    callerWhere: WhereInputBySubject[TSubject] = {},
  ): WhereInputBySubject[TSubject] {
    if (ability.cannot(action, subject)) {
      return {
        id: { in: [] },
        AND: [callerWhere],
      } as WhereInputBySubject[TSubject];
    }
    return this.buildWhere(ability, action, subject, callerWhere);
  }

  // `buildWhereOrEmpty` narrowed to a single record.
  buildRecordWhereOrEmpty<TSubject extends ScopableSubject>(
    ability: AppAbility,
    action: AuthorizationAction,
    subject: TSubject,
    recordId: string,
  ): WhereInputBySubject[TSubject] {
    return this.buildWhereOrEmpty(ability, action, subject, {
      id: recordId,
    });
  }

  /**
   * `buildWhere` narrowed to a single record. A record the caller may not
   * reach simply is not found, so callers should use `findFirst`/
   * `findFirstOrThrow` and let P2025 become a 404.
   */
  buildRecordWhere<TSubject extends ScopableSubject>(
    ability: AppAbility,
    action: AuthorizationAction,
    subject: TSubject,
    recordId: string,
  ): WhereInputBySubject[TSubject] {
    return this.buildWhere(ability, action, subject, {
      id: recordId,
    });
  }
}
