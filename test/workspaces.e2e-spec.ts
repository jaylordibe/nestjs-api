import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeededRoleName } from '../src/common/enums/seeded-role-name.enum';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createRegularUser,
  seedRbacCatalog,
  SeededUser,
} from './setup/rbac';
import { createTestApp } from './setup/test-app';

interface WorkspaceBody {
  id: string;
  name: string;
  slug: string;
}
interface ErrorBody {
  errorCode: string;
}
interface PageBody<T> {
  data: T[];
  meta: { total: number };
}

async function createWorkspace(
  app: INestApplication<App>,
  owner: SeededUser,
  slug: string,
): Promise<WorkspaceBody> {
  const response = await request(app.getHttpServer())
    .post('/api/workspaces')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ name: `Workspace ${slug}`, slug })
    .expect(201);
  return response.body as WorkspaceBody;
}

describe('Workspaces (e2e)', () => {
  let app: INestApplication<App>;

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

  it('POST /api/workspaces makes the creator a WORKSPACE_OWNER, atomically', async () => {
    const founder = await createRegularUser(app, 'founder@example.com');
    const workspace = await createWorkspace(app, founder, 'acme');

    const prisma = app.get(PrismaService);
    const membership = await prisma.workspaceMembership.findUniqueOrThrow({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: founder.id },
      },
      include: { role: true },
    });
    expect(membership.role.name).toBe(SeededRoleName.WORKSPACE_OWNER);
    // Audit columns come from the DB, never the API body.
    expect(membership.createdBy).toBe(founder.id);
  });

  it('any registered user may create a workspace (create Workspace ships with PLATFORM_USER)', async () => {
    const user = await createRegularUser(app, 'nobody@example.com');
    await createWorkspace(app, user, 'startup');
  });

  it('GET /api/workspaces lists only the caller’s workspaces', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    await createWorkspace(app, alice, 'alice-co');
    await createWorkspace(app, bob, 'bob-co');

    const response = await request(app.getHttpServer())
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const body = response.body as PageBody<WorkspaceBody>;
    expect(body.meta.total).toBe(1);
    expect(body.data[0]?.slug).toBe('alice-co');
  });

  // `denyAsNotFound` — belonging to no workspace is not a refusal.
  it('GET /api/workspaces returns an empty page for a user with no workspaces', async () => {
    const loner = await createRegularUser(app, 'loner@example.com');
    const response = await request(app.getHttpServer())
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${loner.token}`)
      .expect(200);
    const body = response.body as PageBody<WorkspaceBody>;
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  // The tenant boundary. A 403 would confirm the workspace exists.
  it('GET /api/workspaces/:id returns 404 (not 403) across the tenant boundary', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    const bobsWorkspace = await createWorkspace(app, bob, 'bob-co');

    const response = await request(app.getHttpServer())
      .get(`/api/workspaces/${bobsWorkspace.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
    const body = response.body as ErrorBody;
    expect(body.errorCode).toBe('RESOURCE_NOT_FOUND');
  });

  it('PATCH /api/workspaces/:id returns 404 across the tenant boundary', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    const bobsWorkspace = await createWorkspace(app, bob, 'bob-co');

    await request(app.getHttpServer())
      .patch(`/api/workspaces/${bobsWorkspace.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Hijacked' })
      .expect(404);

    // And the row is untouched.
    const prisma = app.get(PrismaService);
    const row = await prisma.workspace.findUniqueOrThrow({
      where: { id: bobsWorkspace.id },
    });
    expect(row.name).toBe('Workspace bob-co');
  });

  it('an owner may update and soft-delete their own workspace', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const workspace = await createWorkspace(app, owner, 'owned');

    await request(app.getHttpServer())
      .patch(`/api/workspaces/${workspace.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Renamed' })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/workspaces/${workspace.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    const prisma = app.get(PrismaService);
    const row = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(owner.id);
  });

  it('a soft-deleted workspace releases its slug (partial unique index)', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const first = await createWorkspace(app, owner, 'reusable');
    await request(app.getHttpServer())
      .delete(`/api/workspaces/${first.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    // Same slug, brand-new workspace.
    await createWorkspace(app, owner, 'reusable');
  });

  it('rejects a duplicate slug among live workspaces', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createWorkspace(app, owner, 'taken');
    const response = await request(app.getHttpServer())
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Other', slug: 'taken' })
      .expect(409);
    const body = response.body as ErrorBody;
    expect(body.errorCode).toBe('UNIQUE_CONSTRAINT_VIOLATION');
  });

  it('PLATFORM_ADMIN (manage all) sees across every tenant', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    await createWorkspace(app, alice, 'alice-co');
    const bobsWorkspace = await createWorkspace(app, bob, 'bob-co');
    const admin = await createPlatformAdmin(app);

    const list = await request(app.getHttpServer())
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((list.body as PageBody<WorkspaceBody>).meta.total).toBe(2);

    await request(app.getHttpServer())
      .get(`/api/workspaces/${bobsWorkspace.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
  });
});
