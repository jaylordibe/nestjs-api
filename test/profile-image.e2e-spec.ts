import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { FileAssetStatus } from '../src/common/enums/file-asset-status.enum';
import { FILE_STORAGE_ADAPTER } from '../src/common/storage/adapters/file-storage-adapter.interface';
import { FileCleanupHandler } from '../src/modules/files/file-cleanup.handler';
import { FilesService } from '../src/modules/files/files.service';
import { UsersService } from '../src/modules/users/users.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildPdf, buildPng } from './fixtures/files';
import { pauseAfter, pauseBefore, runRace } from './setup/barrier';
import { truncateAll } from './setup/db';
import {
  createPlatformAdmin,
  createRegularUser,
  seedRbacCatalog,
  TEST_PASSWORD,
} from './setup/rbac';
import { RecordingStorageAdapter } from './setup/recording-storage';
import { createTestApp } from './setup/test-app';

interface ProfileImageBody {
  id: string;
  contentType: string;
  width: number;
  height: number;
  url: string;
  urlExpiresAt: string;
}

// The single-file attribute end to end: upload with `POST /files`, attach with
// `PATCH /users/me { profileImageFileId }`, read it back signed.
describe('Profile image (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const storage = new RecordingStorageAdapter();

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(FILE_STORAGE_ADAPTER).useValue(storage),
    );
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await truncateAll(app);
    await seedRbacCatalog(app);
    storage.reset();
  });

  afterAll(async () => {
    await app.close();
  });

  async function uploadFile(
    token: string,
    purpose = 'profile_image',
    body?: Buffer,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .field('purpose', purpose)
      .attach('file', body ?? (await buildPng(40, 30)), 'me.png')
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function setProfileImage(
    token: string,
    profileImageFileId: string | null | undefined,
    extra: Record<string, unknown> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send(
        profileImageFileId === undefined
          ? extra
          : { profileImageFileId, ...extra },
      );
  }

  // Resolves once some backend in this worker's database is waiting on a row
  // lock — proof the racing statement is blocked, without guessing a delay.
  async function waitForLockWaiter(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row && row.waiting > 0n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('No statement started waiting on a lock within 10s');
  }

  async function fileStatus(fileId: string): Promise<string | undefined> {
    const file = await prisma.fileAsset.findUnique({ where: { id: fileId } });
    return file?.status;
  }

  it('attaches an uploaded file and returns it with a short-lived signed URL', async () => {
    const user = await createRegularUser(app, 'pic@example.com');
    const fileId = await uploadFile(user.token);

    const res = await setProfileImage(user.token, fileId).expect(200);
    const image = res.body.profileImage as ProfileImageBody;
    expect(image).toMatchObject({
      id: fileId,
      contentType: 'image/png',
      width: 40,
      height: 30,
    });
    expect(image.url).toContain('signature=');
    expect(new Date(image.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(res.body)).not.toMatch(
      /profileImageFileId|storageKey/,
    );
    expect(await fileStatus(fileId)).toBe(FileAssetStatus.ATTACHED);

    const me = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect((me.body.profileImage as ProfileImageBody).id).toBe(fileId);
  });

  it('leaves the picture alone when the field is omitted', async () => {
    const user = await createRegularUser(app, 'omit@example.com');
    const fileId = await uploadFile(user.token);
    await setProfileImage(user.token, fileId).expect(200);

    const res = await setProfileImage(user.token, undefined, {
      firstName: 'Renamed',
    }).expect(200);
    expect(res.body.firstName).toBe('Renamed');
    expect((res.body.profileImage as ProfileImageBody).id).toBe(fileId);
  });

  it('replaces the picture and releases the old file', async () => {
    const user = await createRegularUser(app, 'replace@example.com');
    const firstId = await uploadFile(user.token);
    const secondId = await uploadFile(user.token);
    await setProfileImage(user.token, firstId).expect(200);

    const res = await setProfileImage(user.token, secondId).expect(200);
    expect((res.body.profileImage as ProfileImageBody).id).toBe(secondId);
    expect(await fileStatus(firstId)).toBe(FileAssetStatus.DELETING);

    // The released file goes on the next cleanup run; the current one stays.
    await app.get(FileCleanupHandler).runOnce();
    expect(await fileStatus(firstId)).toBeUndefined();
    expect(await fileStatus(secondId)).toBe(FileAssetStatus.ATTACHED);
  });

  it('removes the picture on null and releases the file', async () => {
    const user = await createRegularUser(app, 'remove@example.com');
    const fileId = await uploadFile(user.token);
    await setProfileImage(user.token, fileId).expect(200);

    const res = await setProfileImage(user.token, null).expect(200);
    expect(res.body.profileImage).toBeNull();
    expect(await fileStatus(fileId)).toBe(FileAssetStatus.DELETING);
  });

  // A client that lost the first response and sends the same request again.
  it('treats a retry with the current picture as a no-op', async () => {
    const user = await createRegularUser(app, 'retry@example.com');
    const fileId = await uploadFile(user.token);
    await setProfileImage(user.token, fileId).expect(200);

    const res = await setProfileImage(user.token, fileId).expect(200);
    expect((res.body.profileImage as ProfileImageBody).id).toBe(fileId);
    expect(await fileStatus(fileId)).toBe(FileAssetStatus.ATTACHED);
  });

  it('refuses a file that was already used, expired, or is being deleted with 409', async () => {
    const user = await createRegularUser(app, 'reuse@example.com');
    const usedId = await uploadFile(user.token);
    const nextId = await uploadFile(user.token);
    await setProfileImage(user.token, usedId).expect(200);
    await setProfileImage(user.token, nextId).expect(200);

    // `usedId` was attached, then released by the replacement.
    const released = await setProfileImage(user.token, usedId).expect(409);
    expect(released.body.errorCode).toBe('FILE_NOT_ATTACHABLE');

    const expiredId = await uploadFile(user.token);
    await prisma.fileAsset.update({
      where: { id: expiredId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await setProfileImage(user.token, expiredId).expect(409);
    expect(expired.body.errorCode).toBe('FILE_NOT_ATTACHABLE');

    // Nothing changed: the current picture is still the replacement.
    const me = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${user.token}`)
      .expect(200);
    expect((me.body.profileImage as ProfileImageBody).id).toBe(nextId);
  });

  it("refuses another person's file with 404, and never attaches it", async () => {
    const owner = await createRegularUser(app, 'owner@example.com');
    const thief = await createRegularUser(app, 'thief@example.com');
    const fileId = await uploadFile(owner.token);

    const res = await setProfileImage(thief.token, fileId).expect(404);
    expect(res.body.errorCode).toBe('RESOURCE_NOT_FOUND');
    expect(await fileStatus(fileId)).toBe(FileAssetStatus.READY);

    // Indistinguishable from an id that does not exist at all.
    const unknown = await setProfileImage(
      thief.token,
      '00000000-0000-4000-8000-000000000000',
    ).expect(404);
    expect(unknown.body.errorCode).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuses a file uploaded for another purpose with 404', async () => {
    const user = await createRegularUser(app, 'purpose@example.com');
    const documentId = await uploadFile(user.token, 'document', buildPdf());

    const res = await setProfileImage(user.token, documentId).expect(404);
    expect(res.body.errorCode).toBe('RESOURCE_NOT_FOUND');
    expect(await fileStatus(documentId)).toBe(FileAssetStatus.READY);
  });

  it('refuses a profileImageFileId that is not a uuid with 400', async () => {
    const user = await createRegularUser(app, 'baduuid@example.com');
    const res = await setProfileImage(user.token, 'not-a-uuid').expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  describe('races', () => {
    // Cleanup claims the expired file while the attach is waiting to: the
    // attach must then fail, and nothing may point at the deleted file.
    it('an attach that loses to cleanup fails and leaves no dangling reference', async () => {
      const user = await createRegularUser(app, 'race-cleanup@example.com');
      const fileId = await uploadFile(user.token);

      const paused = pauseBefore(app.get(FilesService), 'claimForAttachment');
      const outcome = await runRace(
        setProfileImage(user.token, fileId),
        paused,
        // Run as if the upload had expired by now.
        () =>
          app
            .get(FileCleanupHandler)
            .runOnce(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)),
      );

      expect(outcome.racer.status).toBe('fulfilled');
      expect(outcome.paused.status).toBe('fulfilled');
      const response = (
        outcome.paused as PromiseFulfilledResult<request.Response>
      ).value;
      expect(response.status).toBe(404);
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(row.profileImageFileId).toBeNull();
      expect(await fileStatus(fileId)).toBeUndefined();
    });

    // Truly interleaved: the attach has claimed the row inside its still-open
    // transaction when cleanup's claim arrives. Cleanup must wait on the row
    // lock, re-check the condition after the attach commits, and match
    // nothing — a find-then-update cleanup would release an attached file.
    it("cleanup's claim waits for an open attach and then leaves the file alone", async () => {
      const user = await createRegularUser(app, 'race-open@example.com');
      const fileId = await uploadFile(user.token);

      const paused = pauseAfter(app.get(FilesService), 'claimForAttachment');
      try {
        const attach = Promise.allSettled([
          setProfileImage(user.token, fileId),
        ]);
        await paused.reached;
        const cleanup = app
          .get(FileCleanupHandler)
          .runOnce(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
        await waitForLockWaiter();
        paused.release();
        const [[attachResult], cleanupResult] = await Promise.all([
          attach,
          cleanup,
        ]);
        expect(
          (attachResult as PromiseFulfilledResult<request.Response>).value
            .status,
        ).toBe(200);
        expect(cleanupResult.released).toBe(0);
      } finally {
        paused.restore();
      }
      expect(await fileStatus(fileId)).toBe(FileAssetStatus.ATTACHED);
    });

    // The attach commits first; a cleanup run that read the file as expiring
    // must not undo it.
    it('cleanup never releases a file an attach already claimed', async () => {
      const user = await createRegularUser(app, 'race-attach@example.com');
      const fileId = await uploadFile(user.token);

      const paused = pauseBefore(app.get(FilesService), 'cleanUp');
      const outcome = await runRace(
        app
          .get(FileCleanupHandler)
          .runOnce(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)),
        paused,
        async () => setProfileImage(user.token, fileId).expect(200),
      );

      expect(outcome.paused.status).toBe('fulfilled');
      expect(outcome.racer.status).toBe('fulfilled');
      expect(await fileStatus(fileId)).toBe(FileAssetStatus.ATTACHED);
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(row.profileImageFileId).toBe(fileId);
    });

    // Two pictures set at once. The first request is held after it took the
    // user row lock and read the current picture; the second is sent while it
    // waits. Without the lock, both would read "no picture", both would claim
    // their file, and the loser's file would stay attached with nothing
    // pointing at it. With the lock, the second waits its turn: one file is
    // current and the other is released.
    //
    // Not `runRace`: that awaits the racer before releasing, and here the
    // racer is SUPPOSED to block on the held lock until the release.
    it('two concurrent changes leave one current picture and release the other', async () => {
      const user = await createRegularUser(app, 'race-two@example.com');
      const firstId = await uploadFile(user.token);
      const secondId = await uploadFile(user.token);

      const paused = pauseBefore(app.get(FilesService), 'claimForAttachment');
      try {
        const first = Promise.allSettled([
          setProfileImage(user.token, firstId),
        ]);
        await paused.reached;
        const second = Promise.allSettled([
          setProfileImage(user.token, secondId),
        ]);
        // The second request is provably parked on the user row lock.
        await waitForLockWaiter();
        paused.release();
        const [[firstResult], [secondResult]] = await Promise.all([
          first,
          second,
        ]);
        expect(firstResult.status).toBe('fulfilled');
        expect(secondResult.status).toBe('fulfilled');
        const statuses = [firstResult, secondResult].map(
          (result) =>
            (result as PromiseFulfilledResult<request.Response>).value.status,
        );
        expect(statuses).toEqual([200, 200]);
      } finally {
        paused.restore();
      }

      // Serialized: the second request ran after the first committed.
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(row.profileImageFileId).toBe(secondId);
      expect(await fileStatus(secondId)).toBe(FileAssetStatus.ATTACHED);
      expect(await fileStatus(firstId)).toBe(FileAssetStatus.DELETING);
    });
  });

  // Login and refresh commit a session BEFORE the response is built. A storage
  // outage must cost the picture, never the tokens already issued — a lost
  // refresh response would make the client's retry look like token theft.
  it('still delivers login and refresh tokens when the picture cannot be signed', async () => {
    const user = await createRegularUser(app, 'sign-outage@example.com');
    const fileId = await uploadFile(user.token);
    await setProfileImage(user.token, fileId).expect(200);
    storage.isSignFailing = true;

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: 'sign-outage@example.com', password: TEST_PASSWORD })
      .expect(200);
    expect(login.body.user.profileImage).toBeNull();

    const refreshed = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    expect(refreshed.body.user.profileImage).toBeNull();
    // The rotated token is live: the family was not revoked.
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(200);
  });

  // A password change ends every session and starts a new one before the
  // response is built; a signing failure must not swallow that new session.
  it('still delivers the new session from a password change when signing fails', async () => {
    const user = await createRegularUser(app, 'pw-sign@example.com');
    const fileId = await uploadFile(user.token);
    await setProfileImage(user.token, fileId).expect(200);
    storage.isSignFailing = true;

    const res = await request(app.getHttpServer())
      .patch('/api/users/me/password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'another-horse-9' })
      .expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.profileImage).toBeNull();
  });

  // Only the person attaches their own picture: the admin update body does
  // not carry the field at all.
  it('refuses profileImageFileId on the admin update', async () => {
    const admin = await createPlatformAdmin(app);
    const user = await createRegularUser(app, 'admin-pic@example.com');
    const fileId = await uploadFile(admin.token);

    const res = await request(app.getHttpServer())
      .patch(`/api/users/${user.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ profileImageFileId: fileId })
      .expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('returns each user their own picture in the admin list and on login', async () => {
    const admin = await createPlatformAdmin(app);
    const first = await createRegularUser(app, 'list-one@example.com');
    const second = await createRegularUser(app, 'list-two@example.com');
    const firstFile = await uploadFile(first.token);
    const secondFile = await uploadFile(second.token);
    await setProfileImage(first.token, firstFile).expect(200);
    await setProfileImage(second.token, secondFile).expect(200);

    const list = await request(app.getHttpServer())
      .get('/api/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .expect(200);
    const pictureByUser = new Map(
      (
        list.body.data as { id: string; profileImage: { id: string } | null }[]
      ).map((row) => [row.id, row.profileImage?.id ?? null]),
    );
    expect(pictureByUser.get(first.id)).toBe(firstFile);
    expect(pictureByUser.get(second.id)).toBe(secondFile);
    expect(pictureByUser.get(admin.id)).toBeNull();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ identifier: 'list-two@example.com', password: TEST_PASSWORD })
      .expect(200);
    expect(login.body.user.profileImage.id).toBe(secondFile);
  });

  // An edit already past its first read when the account is erased must not
  // write personal data back onto the anonymised row.
  it('refuses an in-flight profile edit once the account was erased', async () => {
    const user = await createRegularUser(app, 'erase-race@example.com');
    const paused = pauseBefore(app.get(UsersService), 'findById');
    try {
      const edit = Promise.allSettled([
        setProfileImage(user.token, undefined, { firstName: 'Restored' }),
      ]);
      await paused.reached;
      await request(app.getHttpServer())
        .post('/api/users/me/gdpr-erase')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ currentPassword: TEST_PASSWORD })
        .expect(204);
      paused.release();
      const [result] = await edit;
      expect(
        (result as PromiseFulfilledResult<request.Response>).value.status,
      ).toBe(404);
    } finally {
      paused.restore();
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.firstName).toBe('Deleted');
  });

  it('GDPR erase releases the picture and every unattached upload', async () => {
    const user = await createRegularUser(app, 'erase-files@example.com');
    const pictureId = await uploadFile(user.token);
    const pendingId = await uploadFile(user.token, 'document', buildPdf());
    await setProfileImage(user.token, pictureId).expect(200);

    await request(app.getHttpServer())
      .post('/api/users/me/gdpr-erase')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ currentPassword: TEST_PASSWORD })
      .expect(204);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.profileImageFileId).toBeNull();
    expect(await fileStatus(pictureId)).toBe(FileAssetStatus.DELETING);
    expect(await fileStatus(pendingId)).toBe(FileAssetStatus.DELETING);

    await app.get(FileCleanupHandler).runOnce();
    expect(await prisma.fileAsset.count()).toBe(0);
    expect(storage.objects.size).toBe(0);
  });
});
