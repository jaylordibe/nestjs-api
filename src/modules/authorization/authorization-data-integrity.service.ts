import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessInvitationStatus } from '../../common/enums/business-invitation-status.enum';
import { BusinessMembershipStatus } from '../../common/enums/business-membership-status.enum';
import { RoleScope } from '../../common/enums/role-scope.enum';
import { PrismaService } from '../../prisma/prisma.service';

/** One class of corruption, with enough detail to act on and no personal data. */
export interface AuthorizationDataDefect {
  kind:
    | 'business_role_assigned_platform_wide'
    | 'platform_role_in_membership'
    | 'platform_role_in_invitation'
    | 'unknown_membership_status'
    | 'unknown_invitation_status';
  /** How many rows are affected. Never which users. */
  count: number;
  /** Role names or status values — catalog vocabulary, not user data. */
  offenders: string[];
}

/**
 * Refuses to boot on stored authorization state that no code path should have
 * been able to write.
 *
 * Distinct from `PermissionCatalogIntegrityService`, which checks that the
 * catalog and the database agree about what permissions and roles EXIST. This
 * checks the ASSIGNMENTS — that no role has been attached somewhere its scope
 * makes meaningless — and the two fail for entirely different reasons.
 *
 * Why this is worth a boot gate rather than a dashboard: a BUSINESS role sitting
 * in `user_roles` is a request for platform-wide authority. `AbilityFactory`
 * already refuses to compile it (that is the control that actually holds), but a
 * row that exists and is silently ignored is indistinguishable from one that was
 * never written — so a bug, a bad backfill, or a manual `INSERT` that reached
 * for the wrong table leaves no trace anyone will find. Failing at boot means
 * somebody looks.
 *
 * Deliberately NOT enforced with a database constraint. The brief rules that
 * out, and the reason holds independently: a CHECK coupling `user_roles` to
 * `roles.scope` needs the scope denormalised into the assignment table, which
 * then has to be kept in step with the catalog on every seed — a second source
 * of truth introduced to guard the first.
 *
 * **Diagnostics carry counts and catalog vocabulary only** — never an email, a
 * user id, or a business id. A boot log is read by more people, and retained
 * longer, than any table it describes.
 */
@Injectable()
export class AuthorizationDataIntegrityService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthorizationDataIntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // The e2e harness truncates every table between specs, so there is nothing
    // to validate at boot — matching `PermissionCatalogIntegrityService`. The
    // logic itself is covered directly by its own spec, against deliberately
    // corrupted rows.
    if (this.configService.getOrThrow<string>('nodeEnv') === 'test') return;

    await this.assertStoredAssignmentsAreCoherent();
  }

  async assertStoredAssignmentsAreCoherent(): Promise<void> {
    const defects = await this.findDefects();
    if (defects.length > 0) {
      throw new Error(
        'Stored authorization state is not coherent. The application will not ' +
          'start; these rows grant nothing at runtime (AbilityFactory fails ' +
          'closed on them) but they should not exist.\n  - ' +
          defects.map(describeDefect).join('\n  - '),
      );
    }
    this.logger.log('Stored authorization assignments verified');
  }

  /** Every defect, so one boot reports all of them rather than the first. */
  async findDefects(): Promise<AuthorizationDataDefect[]> {
    const [
      businessRolesHeldPlatformWide,
      platformRolesInMemberships,
      platformRolesInInvitations,
      membershipStatuses,
      invitationStatuses,
    ] = await Promise.all([
      this.prisma.userRole.groupBy({
        by: ['roleId'],
        where: { role: { scope: RoleScope.BUSINESS } },
        _count: { _all: true },
      }),
      this.prisma.businessMembership.groupBy({
        by: ['roleId'],
        where: { role: { scope: RoleScope.PLATFORM } },
        _count: { _all: true },
      }),
      this.prisma.businessInvitation.groupBy({
        by: ['roleId'],
        where: { role: { scope: RoleScope.PLATFORM } },
        _count: { _all: true },
      }),
      this.prisma.businessMembership.groupBy({
        by: ['status'],
        where: {
          status: { notIn: Object.values(BusinessMembershipStatus) },
        },
        _count: { _all: true },
      }),
      this.prisma.businessInvitation.groupBy({
        by: ['status'],
        where: {
          status: { notIn: Object.values(BusinessInvitationStatus) },
        },
        _count: { _all: true },
      }),
    ]);

    const defects: AuthorizationDataDefect[] = [];
    await this.collectRoleDefect(
      defects,
      'business_role_assigned_platform_wide',
      businessRolesHeldPlatformWide,
    );
    await this.collectRoleDefect(
      defects,
      'platform_role_in_membership',
      platformRolesInMemberships,
    );
    await this.collectRoleDefect(
      defects,
      'platform_role_in_invitation',
      platformRolesInInvitations,
    );
    collectStatusDefect(
      defects,
      'unknown_membership_status',
      membershipStatuses,
    );
    collectStatusDefect(
      defects,
      'unknown_invitation_status',
      invitationStatuses,
    );
    return defects;
  }

  /**
   * Turns role ids into role NAMES before they reach a diagnostic.
   *
   * A role id is not personal data, but it is also not actionable without a
   * second query nobody will run while triaging a failed boot.
   */
  private async collectRoleDefect(
    defects: AuthorizationDataDefect[],
    kind: AuthorizationDataDefect['kind'],
    groups: { roleId: string; _count: { _all: number } }[],
  ): Promise<void> {
    if (groups.length === 0) return;
    const roles = await this.prisma.role.findMany({
      where: { id: { in: groups.map((group) => group.roleId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(roles.map((role) => [role.id, role.name]));
    defects.push({
      kind,
      count: groups.reduce((total, group) => total + group._count._all, 0),
      offenders: groups
        .map((group) => nameById.get(group.roleId) ?? group.roleId)
        .sort(),
    });
  }
}

function collectStatusDefect(
  defects: AuthorizationDataDefect[],
  kind: AuthorizationDataDefect['kind'],
  groups: { status: string; _count: { _all: number } }[],
): void {
  if (groups.length === 0) return;
  defects.push({
    kind,
    count: groups.reduce((total, group) => total + group._count._all, 0),
    offenders: groups.map((group) => group.status).sort(),
  });
}

const DEFECT_DESCRIPTIONS: Record<AuthorizationDataDefect['kind'], string> = {
  business_role_assigned_platform_wide:
    'BUSINESS-scoped role(s) assigned platform-wide in `user_roles`',
  platform_role_in_membership:
    'PLATFORM-scoped role(s) attached to a business membership',
  platform_role_in_invitation:
    'PLATFORM-scoped role(s) attached to a business invitation',
  unknown_membership_status:
    'business membership(s) carrying a status outside `BusinessMembershipStatus`',
  unknown_invitation_status:
    'business invitation(s) carrying a status outside `BusinessInvitationStatus`',
};

function describeDefect(defect: AuthorizationDataDefect): string {
  return `${defect.count} ${DEFECT_DESCRIPTIONS[defect.kind]}: ${defect.offenders.join(', ')}`;
}
