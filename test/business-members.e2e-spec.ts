import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createRegularUser,
  seedRbacCatalog,
  SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface ErrorBody {
  errorCode: string;
}
interface MemberBody {
  id: string;
  userId: string;
  role: { name: string };
}

describe('Business members (e2e)', () => {
  let app: INestApplication<App>;

  const roleIdFor = async (name: SeededRoleName): Promise<string> => {
    const prisma = app.get(PrismaService);
    const role = await prisma.role.findUniqueOrThrow({ where: { name } });
    return role.id;
  };

  const createBusiness = async (owner: SeededUser): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
    return (response.body as { id: string }).id;
  };

  const addMember = (
    businessId: string,
    actor: SeededUser,
    email: string,
    roleId: string,
  ) =>
    request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/members`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({ email, roleId });

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('an owner may add a staff member', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createRegularUser(app, 'staff@example.com');
    const businessId = await createBusiness(owner);

    const response = await addMember(
      businessId,
      owner,
      'staff@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_STAFF),
    ).expect(201);
    const body = response.body as MemberBody;
    expect(body.role.name).toBe(SeededRoleName.BUSINESS_STAFF);
  });

  // ── the privilege-escalation guard ──────────────────────────────────────

  it('BUSINESS_ADMIN cannot promote anyone to BUSINESS_OWNER (rank guard)', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const admin = await createRegularUser(app, 'admin@example.com');
    await createRegularUser(app, 'victim@example.com');
    const businessId = await createBusiness(owner);

    await addMember(
      businessId,
      owner,
      'admin@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_ADMIN),
    ).expect(201);

    const response = await addMember(
      businessId,
      admin,
      'victim@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_OWNER),
    ).expect(403);
    expect((response.body as ErrorBody).errorCode).toBe('PERMISSION_DENIED');
  });

  it('BUSINESS_ADMIN cannot promote ITSELF to BUSINESS_OWNER', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const admin = await createRegularUser(app, 'admin@example.com');
    const businessId = await createBusiness(owner);

    const created = await addMember(
      businessId,
      owner,
      'admin@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_ADMIN),
    ).expect(201);
    const adminMemberId = (created.body as MemberBody).id;

    const response = await request(app.getHttpServer())
      .patch(`/api/businesses/${businessId}/members/${adminMemberId}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ roleId: await roleIdFor(SeededRoleName.BUSINESS_OWNER) })
      .expect(403);
    expect((response.body as ErrorBody).errorCode).toBe('PERMISSION_DENIED');

    // And the row is untouched.
    const prisma = app.get(PrismaService);
    const membership = await prisma.businessMember.findUniqueOrThrow({
      where: { id: adminMemberId },
      include: { role: true },
    });
    expect(membership.role.name).toBe(SeededRoleName.BUSINESS_ADMIN);
  });

  it('BUSINESS_MANAGER cannot assign roles at all (no assignRole grant)', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const manager = await createRegularUser(app, 'manager@example.com');
    const businessId = await createBusiness(owner);

    const created = await addMember(
      businessId,
      owner,
      'manager@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_MANAGER),
    ).expect(201);
    const memberId = (created.body as MemberBody).id;

    await request(app.getHttpServer())
      .patch(`/api/businesses/${businessId}/members/${memberId}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ roleId: await roleIdFor(SeededRoleName.BUSINESS_ADMIN) })
      .expect(403);
  });

  it('BUSINESS_ADMIN may assign a role at or below its own rank', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const admin = await createRegularUser(app, 'admin@example.com');
    await createRegularUser(app, 'newbie@example.com');
    const businessId = await createBusiness(owner);

    await addMember(
      businessId,
      owner,
      'admin@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_ADMIN),
    ).expect(201);

    // Lateral (peer admin) is allowed — it is not an escalation.
    await addMember(
      businessId,
      admin,
      'newbie@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_ADMIN),
    ).expect(201);
  });

  it('an owner may appoint a co-owner', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createRegularUser(app, 'coowner@example.com');
    const businessId = await createBusiness(owner);

    await addMember(
      businessId,
      owner,
      'coowner@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_OWNER),
    ).expect(201);
  });

  // ── the last-owner invariant ────────────────────────────────────────────

  it('the last owner cannot be removed', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const businessId = await createBusiness(owner);

    const prisma = app.get(PrismaService);
    const membership = await prisma.businessMember.findUniqueOrThrow({
      where: { businessId_userId: { businessId, userId: owner.id } },
    });

    const response = await request(app.getHttpServer())
      .delete(`/api/businesses/${businessId}/members/${membership.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(409);
    expect((response.body as ErrorBody).errorCode).toBe('RESOURCE_CONFLICT');
  });

  it('the last owner cannot be demoted', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const businessId = await createBusiness(owner);

    const prisma = app.get(PrismaService);
    const membership = await prisma.businessMember.findUniqueOrThrow({
      where: { businessId_userId: { businessId, userId: owner.id } },
    });

    await request(app.getHttpServer())
      .patch(`/api/businesses/${businessId}/members/${membership.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ roleId: await roleIdFor(SeededRoleName.BUSINESS_STAFF) })
      .expect(409);
  });

  it('an owner may be removed once a co-owner exists', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createRegularUser(app, 'coowner@example.com');
    const businessId = await createBusiness(owner);

    await addMember(
      businessId,
      owner,
      'coowner@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_OWNER),
    ).expect(201);

    const prisma = app.get(PrismaService);
    const membership = await prisma.businessMember.findUniqueOrThrow({
      where: { businessId_userId: { businessId, userId: owner.id } },
    });
    await request(app.getHttpServer())
      .delete(`/api/businesses/${businessId}/members/${membership.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);
  });

  // ── tenant isolation ────────────────────────────────────────────────────

  it('a member of another business cannot touch this roster', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    await createRegularUser(app, 'target@example.com');

    const bobsBusiness = await createBusiness(bob);
    // Alice owns a different business, so she DOES hold business-scoped rules
    // — just not for Bob's tenant.
    await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Alice Co', slug: 'alice-co' })
      .expect(201);

    const response = await addMember(
      bobsBusiness,
      alice,
      'target@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_STAFF),
    ).expect(403);
    expect((response.body as ErrorBody).errorCode).toBe('PERMISSION_DENIED');
  });

  it('rejects a PLATFORM-scoped role inside a business', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createRegularUser(app, 'staff@example.com');
    const businessId = await createBusiness(owner);

    const response = await addMember(
      businessId,
      owner,
      'staff@example.com',
      await roleIdFor(SeededRoleName.PLATFORM_ADMIN),
    ).expect(400);
    expect((response.body as ErrorBody).errorCode).toBe('VALIDATION_FAILED');
  });

  it('PLATFORM_ADMIN outranks everyone and may appoint an owner', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createRegularUser(app, 'someone@example.com');
    const businessId = await createBusiness(owner);
    const admin = await createPlatformAdmin(app);

    await addMember(
      businessId,
      admin,
      'someone@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_OWNER),
    ).expect(201);
  });
  // ── soft-delete leakage through relations ───────────────────────────────

  // `prisma.scoped` only filters TOP-LEVEL reads; a nested `include` of a
  // soft-deleted user would otherwise surface it in the roster.
  it('a soft-deleted user disappears from the roster', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const staff = await createRegularUser(app, 'staff@example.com');
    const businessId = await createBusiness(owner);
    await addMember(
      businessId,
      owner,
      'staff@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_STAFF),
    ).expect(201);

    const beforeDeletion = await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(
      (beforeDeletion.body as { meta: { total: number } }).meta.total,
    ).toBe(2);

    const prisma = app.get(PrismaService);
    await prisma.user.update({
      where: { id: staff.id },
      data: { deletedAt: new Date() },
    });

    const afterDeletion = await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    const body = afterDeletion.body as {
      meta: { total: number };
      data: Array<{ user: { email: string } }>;
    };
    expect(body.meta.total).toBe(1);
    expect(body.data.map((member) => member.user.email)).not.toContain(
      'staff@example.com',
    );
  });

  // ── audit snapshots: what the row WAS, at the moment it was removed ──────

  it('removing a member records a snapshot in the audit trail', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createRegularUser(app, 'staff@example.com');
    const businessId = await createBusiness(owner);
    const created = await addMember(
      businessId,
      owner,
      'staff@example.com',
      await roleIdFor(SeededRoleName.BUSINESS_STAFF),
    ).expect(201);
    const memberId = (created.body as MemberBody).id;

    await request(app.getHttpServer())
      .delete(`/api/businesses/${businessId}/members/${memberId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    // Audit rows are read from the DB, never from an API body.
    const prisma = app.get(PrismaService);
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'business_member.removed' },
    });
    const metadata = auditRow.metadata as {
      businessId: string;
      snapshot: { id: string; businessId: string; roleId: string };
    };
    expect(metadata.snapshot.id).toBe(memberId);
    expect(metadata.snapshot.businessId).toBe(businessId);
    // The membership row is hard-deleted: this snapshot is the only record it existed.
    expect(
      await prisma.businessMember.findUnique({ where: { id: memberId } }),
    ).toBeNull();
  });
});
