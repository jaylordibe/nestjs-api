import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { PrismaService } from '../src/prisma/prisma.service';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createPlatformUser,
  createRegularUser,
  seedRbacCatalog,
  SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface PageBody<T> {
  data: T[];
  meta: { total: number };
}
interface AuditLogBody {
  id: string;
  action: string;
  actorId: string | null;
  targetUserId: string | null;
}

describe('Audit logs (e2e)', () => {
  let app: INestApplication<App>;
  let admin: SeededUser;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    admin = await createPlatformAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // Exercises the real write path: creating a business records `business.created`.
  const generateAuditRow = async (owner: SeededUser): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Acme', slug: 'acme' })
      .expect(201);
  };

  it('GET /api/audit-logs is denied to an ordinary user', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(403);
  });

  it('PLATFORM_ADMIN can read the audit trail', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await generateAuditRow(owner);

    const response = await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = response.body as PageBody<AuditLogBody>;
    expect(body.data.some((row) => row.action === 'business.created')).toBe(
      true,
    );
  });

  it('PLATFORM_SUPPORT can read the audit trail (read AuditLog)', async () => {
    const support = await createPlatformUser(app, {
      email: 'support@example.com',
      roles: [SeededRoleName.PLATFORM_SUPPORT],
    });
    await request(app.getHttpServer())
      .get('/api/audit-logs')
      .set('Authorization', `Bearer ${support.token}`)
      .expect(200);
  });

  it('filters by action and actorId', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await generateAuditRow(owner);

    const byAction = await request(app.getHttpServer())
      .get('/api/audit-logs?action=business.created')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const actionBody = byAction.body as PageBody<AuditLogBody>;
    expect(actionBody.meta.total).toBe(1);
    expect(actionBody.data[0].actorId).toBe(owner.id);

    const byActor = await request(app.getHttpServer())
      .get(`/api/audit-logs?actorId=${owner.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((byActor.body as PageBody<AuditLogBody>).meta.total).toBe(1);

    const noMatch = await request(app.getHttpServer())
      .get('/api/audit-logs?action=does.not.exist')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((noMatch.body as PageBody<AuditLogBody>).meta.total).toBe(0);
  });

  it('GET /api/audit-logs/:id returns a single row, and 404 for an unknown id', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await generateAuditRow(owner);

    const prisma = app.get(PrismaService);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'business.created' },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/audit-logs/${row.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((response.body as AuditLogBody).action).toBe('business.created');

    await request(app.getHttpServer())
      .get('/api/audit-logs/00000000-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(404);
  });

  it('records role assignment with the target user', async () => {
    const user = await createRegularUser(app, 'user@example.com');
    const prisma = app.get(PrismaService);
    const supportRole = await prisma.role.findUniqueOrThrow({
      where: { name: SeededRoleName.PLATFORM_SUPPORT },
    });

    await request(app.getHttpServer())
      .post(`/api/users/${user.id}/roles`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ roleId: supportRole.id })
      .expect(204);

    const response = await request(app.getHttpServer())
      .get('/api/audit-logs?action=user.role_assigned')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const body = response.body as PageBody<AuditLogBody>;
    expect(body.meta.total).toBe(1);
    expect(body.data[0].actorId).toBe(admin.id);
    expect(body.data[0].targetUserId).toBe(user.id);
  });
});
