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

interface BusinessBody {
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

async function createBusiness(
  app: INestApplication<App>,
  owner: SeededUser,
  slug: string,
): Promise<BusinessBody> {
  const response = await request(app.getHttpServer())
    .post('/api/businesses')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ name: `Business ${slug}`, slug })
    .expect(201);
  return response.body as BusinessBody;
}

describe('Businesses (e2e)', () => {
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

  it('POST /api/businesses makes the creator a BUSINESS_OWNER, atomically', async () => {
    const founder = await createRegularUser(app, 'founder@example.com');
    const business = await createBusiness(app, founder, 'acme');

    const prisma = app.get(PrismaService);
    const membership = await prisma.businessMember.findUniqueOrThrow({
      where: {
        businessId_userId: { businessId: business.id, userId: founder.id },
      },
      include: { role: true },
    });
    expect(membership.role.name).toBe(SeededRoleName.BUSINESS_OWNER);
    // Audit columns come from the DB, never the API body.
    expect(membership.createdBy).toBe(founder.id);
  });

  it('any registered user may create a business (create Business ships with PLATFORM_USER)', async () => {
    const user = await createRegularUser(app, 'nobody@example.com');
    await createBusiness(app, user, 'startup');
  });

  it('GET /api/businesses lists only the caller’s businesses', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    await createBusiness(app, alice, 'alice-co');
    await createBusiness(app, bob, 'bob-co');

    const response = await request(app.getHttpServer())
      .get('/api/businesses')
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const body = response.body as PageBody<BusinessBody>;
    expect(body.meta.total).toBe(1);
    expect(body.data[0].slug).toBe('alice-co');
  });

  // `denyAsNotFound` — belonging to no business is not a refusal.
  it('GET /api/businesses returns an empty page for a user with no businesses', async () => {
    const loner = await createRegularUser(app, 'loner@example.com');
    const response = await request(app.getHttpServer())
      .get('/api/businesses')
      .set('Authorization', `Bearer ${loner.token}`)
      .expect(200);
    const body = response.body as PageBody<BusinessBody>;
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  // The tenant boundary. A 403 would confirm the business exists.
  it('GET /api/businesses/:id returns 404 (not 403) across the tenant boundary', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    const bobsBusiness = await createBusiness(app, bob, 'bob-co');

    const response = await request(app.getHttpServer())
      .get(`/api/businesses/${bobsBusiness.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
    const body = response.body as ErrorBody;
    expect(body.errorCode).toBe('RESOURCE_NOT_FOUND');
  });

  it('PATCH /api/businesses/:id returns 404 across the tenant boundary', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    const bobsBusiness = await createBusiness(app, bob, 'bob-co');

    await request(app.getHttpServer())
      .patch(`/api/businesses/${bobsBusiness.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Hijacked' })
      .expect(404);

    // And the row is untouched.
    const prisma = app.get(PrismaService);
    const row = await prisma.business.findUniqueOrThrow({
      where: { id: bobsBusiness.id },
    });
    expect(row.name).toBe('Business bob-co');
  });

  it('an owner may update and soft-delete their own business', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const business = await createBusiness(app, owner, 'owned');

    await request(app.getHttpServer())
      .patch(`/api/businesses/${business.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Renamed' })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/businesses/${business.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    const prisma = app.get(PrismaService);
    const row = await prisma.business.findUniqueOrThrow({
      where: { id: business.id },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(owner.id);
  });

  it('a soft-deleted business releases its slug (partial unique index)', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const first = await createBusiness(app, owner, 'reusable');
    await request(app.getHttpServer())
      .delete(`/api/businesses/${first.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    // Same slug, brand-new business.
    await createBusiness(app, owner, 'reusable');
  });

  it('rejects a duplicate slug among live businesses', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    await createBusiness(app, owner, 'taken');
    const response = await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Other', slug: 'taken' })
      .expect(409);
    const body = response.body as ErrorBody;
    expect(body.errorCode).toBe('UNIQUE_CONSTRAINT_VIOLATION');
  });

  it('PLATFORM_ADMIN (manage all) sees across every tenant', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    await createBusiness(app, alice, 'alice-co');
    const bobsBusiness = await createBusiness(app, bob, 'bob-co');
    const admin = await createPlatformAdmin(app);

    const list = await request(app.getHttpServer())
      .get('/api/businesses')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((list.body as PageBody<BusinessBody>).meta.total).toBe(2);

    await request(app.getHttpServer())
      .get(`/api/businesses/${bobsBusiness.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
  });
});
