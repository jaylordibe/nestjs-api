import { subject as tagSubject } from '@casl/ability';
import type { PrismaAbility, Subjects } from '@casl/prisma';
import type {
  AppVersion,
  AuditLog,
  Business,
  BusinessCustomer,
  BusinessMember,
  DeviceToken,
  Permission,
  Role,
  User,
} from '@prisma/client';
import type {
  AuthorizationAction,
  AuthorizationSubject,
} from './permission-catalog';

// The application's CASL ability type.
//
// Subject names are the Prisma model names, which is what lets
// `accessibleBy(ability, action).ofType('Business')` resolve to
// `Prisma.BusinessWhereInput`. Keep this map in step with
// AUTHORIZATION_SUBJECTS in `permission-catalog.ts`.
export type AppAbility = PrismaAbility<
  [
    AuthorizationAction,
    (
      | Subjects<{
          User: User;
          Business: Business;
          BusinessMember: BusinessMember;
          BusinessCustomer: BusinessCustomer;
          Role: Role;
          Permission: Permission;
          AppVersion: AppVersion;
          DeviceToken: DeviceToken;
          AuditLog: AuditLog;
        }>
      | 'all'
    ),
  ]
>;

// ── How to check an ability, and why the distinction is load-bearing ──────
//
//   ability.can('update', 'Business')            ← SUBJECT TYPE
//     Asks "does ANY rule grant update on Business?". CASL deliberately
//     IGNORES rule conditions here, because there is no record to test them
//     against. This is all a guard can do: it runs before the row is loaded.
//
//   ability.can('update', subject('Business', row))   ← SUBJECT INSTANCE
//     Evaluates the conditions against a concrete record.
//
// Tenant isolation therefore CANNOT live in a guard. It lives in the query,
// via `accessibleBy` — see AbilityScopedQueryService. A cross-tenant row is
// never loaded, so the caller gets a 404 rather than a 403 (a 403 would
// confirm the record exists).

// The subject argument `AppAbility.can` accepts: a bare subject name, or a
// record tagged with its subject type.
export type AppAbilitySubject = Parameters<AppAbility['can']>[1];

/**
 * Tags a plain object with its CASL subject type.
 *
 * Prisma rows are plain objects with no class identity, so CASL cannot infer
 * the subject from the value — hence the explicit tag. We deliberately do NOT
 * stamp `__caslSubjectType__` onto Prisma rows themselves: those rows get
 * serialized into responses.
 *
 * The cast is load-bearing and safe. CASL's `subject()` is typed to demand a
 * complete model, but a rule condition only ever reads the handful of keys it
 * names (`{ id }`, `{ userId }`, `{ businessId }`). Callers legitimately pass
 * a partial — a guard checking a not-yet-created record has nothing else to
 * give. A missing key simply fails the condition, which is the fail-closed
 * direction.
 */
export function taggedSubject(
  subjectType: AuthorizationSubject,
  record: Record<string, unknown>,
): AppAbilitySubject {
  return tagSubject(
    subjectType as never,
    record as never,
  ) as unknown as AppAbilitySubject;
}
