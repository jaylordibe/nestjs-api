import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { AuthorizationDataIntegrityService } from '../src/modules/authorization/authorization-data-integrity.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  createBusinessWithOwner,
  createRegularUser,
  seedRbacCatalog,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

/**
 * The boot gate on stored authorization state.
 *
 * Driven directly rather than by booting a corrupted application: corrupting one
 * takes writes no endpoint offers, and a spec that restarted the app to observe
 * a failed boot would prove the same thing far more slowly.
 *
 * Every case here is a row `AbilityFactory` already refuses to compile. That is
 * the control that holds; this is the one that makes sure somebody LOOKS. A row
 * that exists and is silently ignored is indistinguishable from one that was
 * never written.
 */
describe('Authorization data integrity (e2e)', () => {
  let app: INestApplication<App>;
  let service: AuthorizationDataIntegrityService;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    service = app.get(AuthorizationDataIntegrityService);
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const roleIdOf = async (name: SeededRoleName): Promise<string> =>
    (await prisma.role.findUniqueOrThrow({ where: { name } })).id;

  it('passes on a correctly seeded database', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createBusinessWithOwner(app, owner.id);

    await expect(service.findDefects()).resolves.toEqual([]);
    await expect(
      service.assertStoredAssignmentsAreCoherent(),
    ).resolves.toBeUndefined();
  });

  it('detects a BUSINESS role assigned platform-wide', async () => {
    // The dangerous direction: business permissions are always `ANY`, so a
    // business role reached through `user_roles` would compile to
    // platform-wide authority with no tenant bound — if the factory did not
    // drop it.
    const user = await createRegularUser(app, 'user@example.com');
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: await roleIdOf(SeededRoleName.BUSINESS_OWNER),
      },
    });

    const defects = await service.findDefects();
    expect(defects).toEqual([
      {
        kind: 'business_role_assigned_platform_wide',
        count: 1,
        offenders: [SeededRoleName.BUSINESS_OWNER],
      },
    ]);
    await expect(service.assertStoredAssignmentsAreCoherent()).rejects.toThrow(
      /BUSINESS-scoped role/,
    );
  });

  it('detects a PLATFORM role attached to a membership', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const business = await createBusinessWithOwner(app, owner.id);
    const intruder = await createRegularUser(app, 'intruder@example.com');
    await prisma.businessMembership.create({
      data: {
        businessId: business.id,
        userId: intruder.id,
        roleId: await roleIdOf(SeededRoleName.PLATFORM_ADMIN),
        status: 'active',
        joinedAt: new Date(),
      },
    });

    expect(await service.findDefects()).toEqual([
      {
        kind: 'platform_role_in_membership',
        count: 1,
        offenders: [SeededRoleName.PLATFORM_ADMIN],
      },
    ]);
  });

  it('detects a PLATFORM role attached to an invitation', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const business = await createBusinessWithOwner(app, owner.id);
    await prisma.businessInvitation.create({
      data: {
        businessId: business.id,
        email: 'stranger@example.com',
        roleId: await roleIdOf(SeededRoleName.PLATFORM_ENGINEER),
        tokenHash: 'not-a-real-token-hash',
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    expect(await service.findDefects()).toEqual([
      {
        kind: 'platform_role_in_invitation',
        count: 1,
        offenders: [SeededRoleName.PLATFORM_ENGINEER],
      },
    ]);
  });

  it('detects a lifecycle value outside the enum', async () => {
    // `status` is a plain `String` column by convention (no DB enums), so the
    // TS enum is the only thing constraining it — and nothing constrains a
    // hand-written UPDATE.
    const owner = await createRegularUser(app, 'owner@example.com');
    const business = await createBusinessWithOwner(app, owner.id);
    await prisma.businessMembership.updateMany({
      where: { businessId: business.id },
      data: { status: 'invited' },
    });

    expect(await service.findDefects()).toEqual([
      {
        kind: 'unknown_membership_status',
        // 'invited' is the retired placeholder state. A row still carrying it
        // is exactly what this check exists to surface after a bad migration.
        count: 1,
        offenders: ['invited'],
      },
    ]);
  });

  it('reports every defect in one pass, not just the first', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    const business = await createBusinessWithOwner(app, user.id);
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: await roleIdOf(SeededRoleName.BUSINESS_MEMBER),
      },
    });
    await prisma.businessMembership.updateMany({
      where: { businessId: business.id },
      data: { status: 'nonsense' },
    });

    const defects = await service.findDefects();
    expect(defects.map((defect) => defect.kind).sort()).toEqual([
      'business_role_assigned_platform_wide',
      'unknown_membership_status',
    ]);
  });

  it('never names a user or a business in its diagnostics', async () => {
    // A boot log is read by more people, and retained longer, than any table it
    // describes.
    const user = await createRegularUser(app, 'leaky@example.com');
    const business = await createBusinessWithOwner(app, user.id, 'leaky-co');
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: await roleIdOf(SeededRoleName.BUSINESS_ADMIN),
      },
    });

    const message = await service
      .assertStoredAssignmentsAreCoherent()
      .then(() => '')
      .catch((error: Error) => error.message);

    expect(message).toContain(SeededRoleName.BUSINESS_ADMIN);
    expect(message).not.toContain(user.id);
    expect(message).not.toContain('leaky@example.com');
    expect(message).not.toContain(business.id);
    expect(message).not.toContain('leaky-co');
  });
});
