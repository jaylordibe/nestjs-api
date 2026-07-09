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
interface CustomerBody {
  id: string;
  userId: string;
  notes: string | null;
}
interface PageBody<T> {
  data: T[];
  meta: { total: number };
}

describe('Business customers (e2e)', () => {
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

  const addStaff = async (
    businessId: string,
    owner: SeededUser,
    email: string,
    role: SeededRoleName,
  ): Promise<void> => {
    await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email, roleId: await roleIdFor(role) })
      .expect(201);
  };

  const selfJoin = (businessId: string, actor: SeededUser) =>
    request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${actor.token}`)
      .send({});

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

  // ── the self-join path (ownership-scoped) ───────────────────────────────

  it('any registered user may become a customer of a business', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);

    const response = await selfJoin(businessId, customer).expect(201);
    expect((response.body as CustomerBody).userId).toBe(customer.id);
  });

  it('joining the same business twice is a conflict', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);

    await selfJoin(businessId, customer).expect(201);
    const response = await selfJoin(businessId, customer).expect(409);
    expect((response.body as ErrorBody).errorCode).toBe('RESOURCE_CONFLICT');
  });

  // The whole reason customers are not `business_members`: that table has
  // `@@unique([businessId, userId])`, so a stylist could never book at the
  // salon they work for.
  it('a staff member may ALSO be a customer of their own business', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const stylist = await createRegularUser(app, 'stylist@example.com');
    const businessId = await createBusiness(owner);
    await addStaff(
      businessId,
      owner,
      stylist.email,
      SeededRoleName.BUSINESS_STAFF,
    );

    await selfJoin(businessId, stylist).expect(201);
  });

  it('one account may be a customer of many businesses', async () => {
    const ownerOne = await createRegularUser(app, 'one@example.com');
    const ownerTwo = await createRegularUser(app, 'two@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');

    const businessOne = await createBusiness(ownerOne);
    const businessTwo = await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${ownerTwo.token}`)
      .send({ name: 'Beta', slug: 'beta' })
      .expect(201);

    await selfJoin(businessOne, customer).expect(201);
    await selfJoin((businessTwo.body as { id: string }).id, customer).expect(
      201,
    );
  });

  // ── a customer holds NO authority over the business ──────────────────────

  it('a customer cannot enrol somebody else', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    await createRegularUser(app, 'victim@example.com');
    const businessId = await createBusiness(owner);
    await selfJoin(businessId, customer).expect(201);

    const response = await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ email: 'victim@example.com' })
      .expect(403);
    expect((response.body as ErrorBody).errorCode).toBe('PERMISSION_DENIED');
  });

  it('a customer cannot write staff notes when joining', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);

    await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ notes: 'I am a VIP' })
      .expect(403);
  });

  it('a customer cannot read the business, its roster, or edit anything', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);
    await selfJoin(businessId, customer).expect(201);

    // Being a customer grants NO `read Business` — the business is not theirs.
    await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/members`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(403);
  });

  it('a customer may edit nothing on their own record (notes are staff-only)', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);
    const created = await selfJoin(businessId, customer).expect(201);
    const customerId = (created.body as CustomerBody).id;

    // They CAN read it…
    await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/customers/${customerId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(200);

    // …but not annotate it. 403, not 404 — they can see the record.
    const response = await request(app.getHttpServer())
      .patch(`/api/businesses/${businessId}/customers/${customerId}`)
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ notes: 'promote me' })
      .expect(403);
    expect((response.body as ErrorBody).errorCode).toBe('PERMISSION_DENIED');
  });

  it('a customer may end their own relationship', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);
    const created = await selfJoin(businessId, customer).expect(201);

    await request(app.getHttpServer())
      .delete(
        `/api/businesses/${businessId}/customers/${(created.body as CustomerBody).id}`,
      )
      .set('Authorization', `Bearer ${customer.token}`)
      .expect(204);
  });

  // ── the dual-scoped read: same endpoint, two audiences ───────────────────

  it('a customer sees ONLY their own record; staff see the whole list', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    const businessId = await createBusiness(owner);

    await selfJoin(businessId, alice).expect(201);
    await selfJoin(businessId, bob).expect(201);

    const asAlice = await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    const aliceBody = asAlice.body as PageBody<CustomerBody>;
    expect(aliceBody.meta.total).toBe(1);
    expect(aliceBody.data[0].userId).toBe(alice.id);

    const asOwner = await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect((asOwner.body as PageBody<CustomerBody>).meta.total).toBe(2);
  });

  it('a customer cannot read another customer’s record (404, not 403)', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    const businessId = await createBusiness(owner);

    await selfJoin(businessId, alice).expect(201);
    const bobRecord = await selfJoin(businessId, bob).expect(201);

    await request(app.getHttpServer())
      .get(
        `/api/businesses/${businessId}/customers/${(bobRecord.body as CustomerBody).id}`,
      )
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(404);
  });

  it('a stranger to the business gets an empty list, not a 403', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const stranger = await createRegularUser(app, 'stranger@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);
    await selfJoin(businessId, customer).expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(200);
    expect((response.body as PageBody<CustomerBody>).data).toEqual([]);
  });

  // ── the business's side ─────────────────────────────────────────────────

  it('staff may enrol a customer and annotate the record', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const staff = await createRegularUser(app, 'staff@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);
    await addStaff(
      businessId,
      owner,
      staff.email,
      SeededRoleName.BUSINESS_STAFF,
    );

    // BUSINESS_STAFF is read-only over customers.
    await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ email: customer.email })
      .expect(403);

    // The owner may.
    const created = await request(app.getHttpServer())
      .post(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: customer.email, notes: 'Prefers mornings' })
      .expect(201);
    expect((created.body as CustomerBody).notes).toBe('Prefers mornings');
  });

  it('staff of another business cannot see this customer list', async () => {
    const alice = await createRegularUser(app, 'alice@example.com');
    const bob = await createRegularUser(app, 'bob@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const bobsBusiness = await createBusiness(bob);
    await selfJoin(bobsBusiness, customer).expect(201);

    // Alice owns a different business, so she holds business-scoped rules —
    // just not for Bob's tenant.
    await request(app.getHttpServer())
      .post('/api/businesses')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ name: 'Alice Co', slug: 'alice-co' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/api/businesses/${bobsBusiness}/customers`)
      .set('Authorization', `Bearer ${alice.token}`)
      .expect(200);
    expect((response.body as PageBody<CustomerBody>).data).toEqual([]);
  });

  it('PLATFORM_ADMIN sees every customer across tenants', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);
    await selfJoin(businessId, customer).expect(201);
    const admin = await createPlatformAdmin(app);

    const response = await request(app.getHttpServer())
      .get(`/api/businesses/${businessId}/customers`)
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    expect((response.body as PageBody<CustomerBody>).meta.total).toBe(1);
  });

  it('customers cascade away when their business is hard-deleted', async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const customer = await createRegularUser(app, 'customer@example.com');
    const businessId = await createBusiness(owner);
    await selfJoin(businessId, customer).expect(201);

    const prisma = app.get(PrismaService);
    await prisma.business.delete({ where: { id: businessId } });
    expect(await prisma.businessCustomer.count({ where: { businessId } })).toBe(
      0,
    );
  });
});
