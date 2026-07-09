import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './setup/test-app';

interface EnumOption {
  value: string;
  label: string;
  description: string | null;
  sortOrder: number;
}

describe('Enums (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // Every registered enum endpoint at once — catches a route pointing at an
  // unregistered key (404 from the lookup helper) the moment it's introduced.
  it.each([
    'role-scopes',
    'permission-ownerships',
    'app-platforms',
    'device-types',
    'device-oses',
  ])(
    'GET /api/enums/%s is public, revalidatable, and returns sorted options',
    async (path) => {
      const res = await request(app.getHttpServer())
        .get(`/api/enums/${path}`)
        .expect(200);

      // Revalidate-on-use policy: clients cache but must check with the origin,
      // so an enum edit shows up on the next request rather than after a TTL.
      expect(res.headers['cache-control']).toContain('no-cache');

      const options = res.body as EnumOption[];
      expect(Array.isArray(options)).toBe(true);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        expect(typeof option.value).toBe('string');
        expect(typeof option.label).toBe('string');
        expect(typeof option.sortOrder).toBe('number');
        expect(option).toHaveProperty('description');
      }
      // sortOrder reflects declaration order, ascending and gap-free (1-based).
      expect(options.map((option) => option.sortOrder)).toEqual(
        options.map((_unused, index) => index + 1),
      );
    },
  );

  it('GET /api/enums returns every registered enum as a keyed map', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/enums')
      .expect(200);
    const body = res.body as Record<string, EnumOption[]>;
    for (const key of [
      'roleScope',
      'permissionOwnership',
      'appPlatform',
      'deviceType',
      'deviceOs',
    ]) {
      expect(Array.isArray(body[key])).toBe(true);
      expect(body[key].length).toBeGreaterThan(0);
    }
  });

  it('applies acronym-casing label overrides for DeviceOs (iOS, macOS), humanizes the rest', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/enums/device-oses')
      .expect(200);
    const options = res.body as EnumOption[];
    expect(options.find((option) => option.value === 'ios')?.label).toBe('iOS');
    expect(options.find((option) => option.value === 'macos')?.label).toBe(
      'macOS',
    );
    // No override → humanized.
    expect(options.find((option) => option.value === 'android')?.label).toBe(
      'Android',
    );
  });

  it('emits an ETag and 304s on a matching If-None-Match (cheap revalidation)', async () => {
    const first = await request(app.getHttpServer())
      .get('/api/enums/role-scopes')
      .expect(200);
    const etag = first.headers['etag'] as string | undefined;
    expect(etag).toBeDefined();

    // A conditional re-fetch with the same ETag revalidates to a bodyless 304.
    const revalidated = await request(app.getHttpServer())
      .get('/api/enums/role-scopes')
      .set('If-None-Match', etag!)
      .expect(304);
    expect(revalidated.body).toEqual({});

    // A stale/mismatched ETag gets the full list back (200 with a body).
    const stale = await request(app.getHttpServer())
      .get('/api/enums/role-scopes')
      .set('If-None-Match', '"stale-etag"')
      .expect(200);
    expect(Array.isArray(stale.body)).toBe(true);
    expect((stale.body as unknown[]).length).toBeGreaterThan(0);
  });
});
