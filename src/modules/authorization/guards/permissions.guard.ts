import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AbilityFactory } from '../ability.factory';
import { PermissionLoaderService } from '../permission-loader.service';
import {
  taggedSubject,
  type AppAbility,
} from '../../../common/authorization/app-ability';
import type {
  AuthorizationAction,
  AuthorizationSubject,
} from '../../../common/authorization/permission-catalog';
import {
  isOwnableSubject,
  isTenantScopedSubject,
  resolveOwnerKey,
  resolveTenantKey,
} from '../../../common/authorization/subject-key';
import { AUTHENTICATED_ONLY_KEY } from '../../../common/decorators/authenticated-only.decorator';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import {
  REQUIRE_PERMISSION_KEY,
  type RequiredPermission,
} from '../../../common/decorators/require-permission.decorator';
import { Errors } from '../../../common/errors/errors';

interface AuthorizedRequest {
  user?: AuthenticatedUser;
  ability?: AppAbility;
  params?: Record<string, string | undefined>;
  body?: unknown;
}

// Global authorization guard. Runs after JwtAuthGuard, which has already
// populated `request.user` (or short-circuited on `@Public()`).
//
// Lives HERE, not in `src/common/guards/`, because it depends on
// `AbilityFactory` and `PermissionLoaderService`. `common/` is the leaf layer
// that `modules/` builds on; a guard in `common/` reaching up into `modules/`
// inverts that and makes the dependency graph a cycle waiting to happen. The
// decorators it reads stay in `common/decorators/` — they are pure metadata
// with no service dependencies, so anything may import them.
//
// Every handler must declare exactly one of `@Public()`,
// `@AuthenticatedOnly()`, or `@RequirePermission()`. A handler that declares
// none is denied here AND fails the boot-time route audit — the guard is
// defence in depth behind a check that stops the app from starting at all.
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: AbilityFactory,
    private readonly permissionLoaderService: PermissionLoaderService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthorizedRequest>();
    const user = request.user;
    if (!user) {
      // JwtAuthGuard should already have rejected this. Fail closed.
      throw Errors.tokenMissing();
    }

    // Build once per request and attach, so `@CurrentAbility()` and the
    // service layer reuse it rather than paying another Redis round trip.
    const grants = await this.permissionLoaderService.loadGrants(user.id);
    const ability = this.abilityFactory.createForUser(user.id, grants);
    request.ability = ability;

    if (
      this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, targets)
    ) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<
      RequiredPermission | undefined
    >(REQUIRE_PERMISSION_KEY, targets);

    if (!required) {
      // Fail closed. The route audit names these at boot; if one somehow
      // reaches production, it denies rather than admits.
      this.logger.error(
        `${context.getClass().name}#${context.getHandler().name} has no authorization decision ` +
          '(@Public / @AuthenticatedOnly / @RequirePermission). Denying.',
      );
      throw Errors.permissionDenied('unknown');
    }

    const { action, subject, administrative, denyAsNotFound } = required;

    // Administrative routes act on records the caller does not own, so an
    // ownership-scoped grant must not unlock them. CASL's type-level check
    // ignores conditions, so ask a sharper question: is there a granting rule
    // that is NOT conditioned on the owner key?
    //
    // Tenant-conditioned rules still qualify — a BUSINESS_ADMIN administers a
    // roster it does not personally own, and the tenant boundary is enforced
    // in the query.
    if (
      administrative &&
      !this.hasNonOwnerScopedRule(ability, action, subject)
    ) {
      throw Errors.permissionDenied(action, subject);
    }

    // A business-scoped subject that is a CHILD of a business (a roster entry,
    // an invoice, …) can only be authorized relative to a tenant, so the route
    // must name one. `Business` itself is exempt: its own id is the tenant, and
    // resolving it here would turn a cross-tenant hit into a 403 that confirms
    // the record exists. Those go through AbilityScopedQueryService → 404.
    const businessId = this.resolveBusinessId(request);
    const isBusinessChildSubject =
      isTenantScopedSubject(subject) && subject !== 'Business';

    if (isBusinessChildSubject && !businessId) {
      throw Errors.businessContextMissing();
    }

    // With a tenant in hand and no record yet loaded — the create-into-business
    // case — the guard can honestly evaluate the condition. Everywhere else it
    // can only ask whether a rule exists at all (CASL ignores conditions when
    // the subject is a type rather than an instance); row and tenant scoping
    // then happen in the query.
    const allowed =
      businessId && isTenantScopedSubject(subject)
        ? ability.can(
            action,
            taggedSubject(
              subject,
              this.buildTenantStub(subject, businessId, user.id),
            ),
          )
        : ability.can(action, subject);

    if (!allowed) {
      // Absence of a grant is answered as "does not exist", not "forbidden":
      // an empty page for a list, 404 for a record. The service still scopes
      // every query, so passing here cannot widen what the caller sees — it
      // only decides which refusal they receive. Without this, the same
      // request would 403 for a user with no businesses and 404 for a user
      // with one.
      if (denyAsNotFound) return true;
      throw Errors.permissionDenied(action, subject);
    }
    return true;
  }

  /**
   * The partial record the guard checks a tenant-scoped rule against.
   *
   * It carries the tenant key AND, when the subject is also ownable, the
   * caller's own id. `BusinessCustomer` is both: staff reach it through a
   * `{ businessId }` rule, a customer through a `{ userId }` rule. Supplying
   * only the tenant key would silently deny the customer — their rule would
   * see `userId: undefined` and fail.
   *
   * Supplying the caller's own id is safe. It answers "may I act on MY record
   * in this business?", which is the only thing the guard could honestly ask
   * before a record exists. Acting on SOMEONE ELSE's record is re-checked in
   * the service with the real target id (`BusinessCustomersService.add`), and
   * every read is scoped by the query.
   */
  private buildTenantStub(
    subject: AuthorizationSubject,
    businessId: string,
    currentUserId: string,
  ): Record<string, unknown> {
    const stub: Record<string, unknown> = {
      [resolveTenantKey(subject)]: businessId,
    };
    if (isOwnableSubject(subject)) {
      stub[resolveOwnerKey(subject)] = currentUserId;
    }
    return stub;
  }

  // True when at least one granting rule is not conditioned on the subject's
  // owner column. `manage all` resolves here with no conditions at all, so a
  // platform admin always qualifies.
  private hasNonOwnerScopedRule(
    ability: AppAbility,
    action: AuthorizationAction,
    subject: AuthorizationSubject,
  ): boolean {
    if (!isOwnableSubject(subject)) {
      // Nothing about this subject is owner-scoped, so any granting rule is
      // by definition administrative in nature.
      return ability.can(action, subject);
    }

    const ownerKey = resolveOwnerKey(subject);
    return ability
      .rulesFor(action, subject)
      .some(
        (rule) =>
          !rule.inverted && !(rule.conditions && ownerKey in rule.conditions),
      );
  }

  // The tenant the request operates in. Canonical source is the route param on
  // nested routes (`/businesses/:businessId/members`); a create that names its
  // parent in the body is the other legitimate case.
  //
  // Deliberately NO `X-Business-Id` header fallback: an ambient, easily-forged
  // tenant selector is attack surface a baseline template should not ship.
  private resolveBusinessId(request: AuthorizedRequest): string | undefined {
    const fromParams = request.params?.businessId;
    if (fromParams) return fromParams;

    const body = request.body;
    if (body && typeof body === 'object' && 'businessId' in body) {
      const fromBody = (body as { businessId?: unknown }).businessId;
      if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
    }
    return undefined;
  }
}
