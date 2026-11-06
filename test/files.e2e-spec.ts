import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import { MULTER_MODULE_OPTIONS } from '@nestjs/platform-express/multer/files.constants';
import {
  FILE_STORAGE_ADAPTER,
  PRIVATE_OBJECT_CACHE_CONTROL,
} from '../src/common/storage/adapters/file-storage-adapter.interface';
import { FileAssetStatus } from '../src/common/enums/file-asset-status.enum';
import { FileCleanupHandler } from '../src/modules/files/file-cleanup.handler';
import { MAX_UNATTACHED_FILES_PER_USER } from '../src/modules/files/file-purpose.policy';
import { FileProcessor } from '../src/modules/files/file-processor';
import { FILE_PURPOSE_POLICIES } from '../src/modules/files/file-purpose.policy';
import { FilePurpose } from '../src/common/enums/file-purpose.enum';
import { FileStorageService } from '../src/common/storage/file-storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  buildHtml,
  buildJpegWithExif,
  buildOfficeDocument,
  buildPdf,
  buildPng,
  buildPngDeclaring,
  buildTruncatedPng,
} from './fixtures/files';
import { pauseBefore } from './setup/barrier';
import { truncateAll } from './setup/db';
import { createRegularUser, seedRbacCatalog } from './setup/rbac';
import { RecordingStorageAdapter } from './setup/recording-storage';
import { createTestApp } from './setup/test-app';

const MEBIBYTE = 1024 * 1024;

interface UploadedFileBody {
  id: string;
  purpose: string;
  status: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  fileName: string;
  expiresAt: string;
}

describe('Files (e2e)', () => {
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

  function upload(
    token: string,
    purpose: string,
    body: Buffer,
    fileName: string,
    declaredType = 'application/octet-stream',
  ): request.Test {
    return request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .field('purpose', purpose)
      .attach('file', body, { filename: fileName, contentType: declaredType });
  }

  describe('POST /api/files', () => {
    it('stores a profile image re-encoded and returns its id, never its storage key', async () => {
      const user = await createRegularUser(app, 'uploader@example.com');
      const res = await upload(
        user.token,
        'profile_image',
        await buildPng(64, 48),
        'me.png',
        'image/png',
      ).expect(201);

      const body = res.body as UploadedFileBody;
      expect(body).toMatchObject({
        purpose: 'profile_image',
        status: 'ready',
        kind: 'image',
        contentType: 'image/png',
        width: 64,
        height: 48,
        fileName: 'me.png',
      });
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(JSON.stringify(res.body)).not.toMatch(/storage|files\//i);

      const row = await prisma.fileAsset.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row).toMatchObject({ uploadedBy: user.id, status: 'ready' });
      const stored = storage.objects.get(row.storageKey);
      expect(stored?.contentType).toBe('image/png');
      expect(stored?.contentDisposition).toMatch(/^inline;/);
      expect(row.storageKey).toMatch(
        /^files\/profile-images\/[0-9a-f-]{36}\.png$/,
      );
    });

    it('stores the re-encoded image without its EXIF and GPS metadata', async () => {
      const user = await createRegularUser(app, 'camera@example.com');
      const original = await buildJpegWithExif();
      expect((await sharp(original).metadata()).exif).toBeDefined();

      const res = await upload(
        user.token,
        'profile_image',
        original,
        'IMG_0001.JPG',
        'image/jpeg',
      ).expect(201);

      const row = await prisma.fileAsset.findUniqueOrThrow({
        where: { id: (res.body as UploadedFileBody).id },
      });
      const stored = storage.objects.get(row.storageKey);
      const metadata = await sharp(stored?.body).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.exif).toBeUndefined();
      expect(row.fileName).toBe('IMG_0001.jpg');
    });

    it.each([
      ['a PDF', buildPdf(), 'report.pdf', 'application/pdf', 'pdf'],
      [
        'a DOCX',
        buildOfficeDocument('docx'),
        'cv.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'docx',
      ],
    ])(
      'stores %s byte-for-byte and serves it as a download',
      async (_label, body, fileName, contentType) => {
        const user = await createRegularUser(app, 'docs@example.com');
        const res = await upload(user.token, 'document', body, fileName).expect(
          201,
        );
        expect(res.body).toMatchObject({
          kind: 'document',
          contentType,
          width: null,
          height: null,
          sizeBytes: body.length,
        });

        const row = await prisma.fileAsset.findUniqueOrThrow({
          where: { id: (res.body as UploadedFileBody).id },
        });
        const stored = storage.objects.get(row.storageKey);
        expect(stored?.body.equals(body)).toBe(true);
        expect(stored?.contentDisposition).toMatch(/^attachment;/);
      },
    );

    // The client's label is ignored; the bytes decide.
    it('refuses an HTML page declared as image/png with 415', async () => {
      const user = await createRegularUser(app, 'polyglot@example.com');
      const res = await upload(
        user.token,
        'profile_image',
        buildHtml(),
        'cute.png',
        'image/png',
      ).expect(415);
      expect(res.body.errorCode).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(await prisma.fileAsset.count()).toBe(0);
      expect(storage.objects.size).toBe(0);
    });

    it('refuses a type the purpose does not accept with 415', async () => {
      const user = await createRegularUser(app, 'wrongtype@example.com');
      const res = await upload(
        user.token,
        'profile_image',
        buildPdf(),
        'me.pdf',
      ).expect(415);
      expect(res.body.errorCode).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it.each([
      ['an image that does not decode', buildTruncatedPng],
      [
        'a decompression bomb (tiny file declaring 20000 × 20000)',
        () => Promise.resolve(buildPngDeclaring(20_000, 20_000)),
      ],
    ])('refuses %s with 422 and releases the row', async (_label, build) => {
      const user = await createRegularUser(app, 'broken@example.com');
      const res = await upload(
        user.token,
        'profile_image',
        await build(),
        'x.png',
      ).expect(422);
      expect(res.body.errorCode).toBe('FILE_CONTENT_INVALID');

      const rows = await prisma.fileAsset.findMany();
      expect(rows.map((row) => row.status)).toEqual([FileAssetStatus.DELETING]);
      expect(storage.objects.size).toBe(0);
    });

    it('refuses a file over the purpose limit with 413', async () => {
      const user = await createRegularUser(app, 'big@example.com');
      // A real PNG header, padded past the 10 MiB profile-image limit.
      const oversized = Buffer.concat([
        await buildPng(),
        Buffer.alloc(10 * MEBIBYTE + 1),
      ]);
      const res = await upload(
        user.token,
        'profile_image',
        oversized,
        'big.png',
      ).expect(413);
      expect(res.body.errorCode).toBe('PAYLOAD_TOO_LARGE');
      expect(await prisma.fileAsset.count()).toBe(0);
    });

    it('stops reading a file over FILE_UPLOAD_MAX_BYTES with 413', async () => {
      const user = await createRegularUser(app, 'huge@example.com');
      const res = await upload(
        user.token,
        'document',
        Buffer.alloc(25 * MEBIBYTE + 1),
        'huge.pdf',
      ).expect(413);
      expect(res.body.errorCode).toBe('PAYLOAD_TOO_LARGE');
    });

    it('refuses an unknown purpose, a missing file, and a second file', async () => {
      const user = await createRegularUser(app, 'bad@example.com');
      const unknownPurpose = await upload(
        user.token,
        'admin_avatar',
        await buildPng(),
        'a.png',
      ).expect(400);
      expect(unknownPurpose.body.errorCode).toBe('VALIDATION_FAILED');

      const missingFile = await request(app.getHttpServer())
        .post('/api/files')
        .set('Authorization', `Bearer ${user.token}`)
        .field('purpose', 'profile_image')
        .expect(400);
      expect(missingFile.body.errorCode).toBe('VALIDATION_FAILED');

      const png = await buildPng();
      const twoFiles = await request(app.getHttpServer())
        .post('/api/files')
        .set('Authorization', `Bearer ${user.token}`)
        .field('purpose', 'profile_image')
        .attach('file', png, 'a.png')
        .attach('file', png, 'b.png');
      // One file per request: multer stops at the second part.
      expect(twoFiles.status).toBe(400);
      expect(twoFiles.body.errorCode).toBe('VALIDATION_FAILED');
      expect(await prisma.fileAsset.count()).toBe(0);
    });

    it('requires a signed-in caller', async () => {
      await request(app.getHttpServer())
        .post('/api/files')
        .field('purpose', 'profile_image')
        .attach('file', await buildPng(), 'a.png')
        .expect(401)
        .expect((res) => expect(res.body.errorCode).toBe('TOKEN_INVALID'));
    });

    // Browsers send the name as UTF-8; it must not come back as latin1 mojibake.
    it('keeps a non-ASCII file name intact', async () => {
      const user = await createRegularUser(app, 'utf8@example.com');
      const res = await upload(
        user.token,
        'document',
        buildPdf(),
        'résumé — 2026.pdf',
      ).expect(201);
      expect((res.body as UploadedFileBody).fileName).toBe('résumé — 2026.pdf');
    });

    // The object's caching comes from the purpose's policy, not one constant.
    it("writes each object with its purpose's cache rule", async () => {
      const user = await createRegularUser(app, 'cache@example.com');
      const res = await upload(
        user.token,
        'profile_image',
        await buildPng(),
        'me.png',
      ).expect(201);
      const row = await prisma.fileAsset.findUniqueOrThrow({
        where: { id: (res.body as UploadedFileBody).id },
      });
      expect(storage.objects.get(row.storageKey)?.cacheControl).toBe(
        FILE_PURPOSE_POLICIES[FilePurpose.PROFILE_IMAGE].cacheControl,
      );
    });

    // A file's dimensions are both set or both absent, and never zero.
    it('refuses a stored file with a zero or half-missing size', async () => {
      const user = await createRegularUser(app, 'sizes@example.com');
      const res = await upload(
        user.token,
        'profile_image',
        await buildPng(),
        'me.png',
      ).expect(201);
      const id = (res.body as UploadedFileBody).id;
      for (const size of [{ width: 0 }, { height: null }]) {
        await expect(
          prisma.fileAsset.update({ where: { id }, data: size }),
        ).rejects.toThrow(/file_assets_dimensions_check/);
      }
    });

    // The cleanup job reclaimed this upload's row while it was still writing:
    // the request must remove the object it wrote, or nothing ever would.
    it('removes its own object when its row was released mid-upload', async () => {
      const user = await createRegularUser(app, 'slow@example.com');
      const paused = pauseBefore(app.get(FileStorageService), 'put');
      try {
        const pending = Promise.allSettled([
          upload(user.token, 'profile_image', await buildPng(), 'slow.png'),
        ]);
        await paused.reached;
        // Run as if the upload had been stuck for an hour.
        await app
          .get(FileCleanupHandler)
          .runOnce(new Date(Date.now() + 60 * 60 * 1000));
        paused.release();
        const [result] = await pending;
        const response = (result as PromiseFulfilledResult<request.Response>)
          .value;
        expect(response.status).toBe(503);
      } finally {
        paused.restore();
      }
      expect(await prisma.fileAsset.count()).toBe(0);
      expect(storage.objects.size).toBe(0);
    });

    // The service re-checks size AFTER the whole body is in memory, so a 413
    // alone cannot show that multer stops reading early. This pins the limit
    // multer itself is given: one file, capped at FILE_UPLOAD_MAX_BYTES.
    // The unit spec proves the cap a FileProcessor is given is the one that
    // refuses; this proves the module gives it FILE_IMAGE_MAX_PIXELS.
    it('gives the image processor the configured pixel cap', () => {
      const processor = app.get(FileProcessor, { strict: false });
      expect(
        (processor as unknown as { maxImagePixels: number }).maxImagePixels,
      ).toBe(40_000_000);
    });

    it('gives multer the configured per-file byte cap', () => {
      const options = app.get<{
        limits: { fileSize: number; files: number };
      }>(MULTER_MODULE_OPTIONS, { strict: false });
      expect(options.limits).toMatchObject({
        fileSize: 25 * MEBIBYTE,
        files: 1,
      });
    });

    // The bytes a server-side upload relay sends: its own `purpose` part
    // first, under a quoted boundary it writes into the Content-Type, so the
    // browser behind it cannot choose what the file is for.
    function rawUpload(token: string, boundary: string, parts: Buffer[]) {
      const body = Buffer.concat([
        ...parts.flatMap((part) => [
          Buffer.from(`--${boundary}\r\n`),
          part,
          Buffer.from('\r\n'),
        ]),
        Buffer.from(`--${boundary}--\r\n`),
      ]);
      return request(app.getHttpServer())
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', `multipart/form-data; boundary="${boundary}"`)
        .send(body);
    }

    const purposePart = (purpose: string) =>
      Buffer.from(
        `Content-Disposition: form-data; name="purpose"\r\n\r\n${purpose}`,
      );

    async function filePart(): Promise<Buffer> {
      return Buffer.concat([
        Buffer.from(
          'Content-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
        ),
        await buildPng(),
      ]);
    }

    it('reads a purpose part written ahead of the file under a quoted boundary', async () => {
      const user = await createRegularUser(app, 'relay@example.com');
      const boundary = '----WebKitFormBoundary7MA4YWxk';
      const res = await rawUpload(user.token, boundary, [
        purposePart('profile_image'),
        await filePart(),
      ]).expect(201);
      expect((res.body as UploadedFileBody).purpose).toBe('profile_image');
    });

    it('reads a quoted boundary holding characters a bare one may not', async () => {
      const user = await createRegularUser(app, 'spaced@example.com');
      const boundary = '----Lysta boundary:1=';
      const res = await rawUpload(user.token, boundary, [
        purposePart('profile_image'),
        await filePart(),
      ]).expect(201);
      expect((res.body as UploadedFileBody).purpose).toBe('profile_image');
    });

    it('refuses a second purpose part after the relay’s own, storing nothing', async () => {
      const user = await createRegularUser(app, 'second@example.com');
      const boundary = '----WebKitFormBoundary7MA4YWxk';
      const res = await rawUpload(user.token, boundary, [
        purposePart('profile_image'),
        purposePart('document'),
        await filePart(),
      ]);
      expect(res.status).toBe(400);
      expect(res.body.errorCode).toBe('VALIDATION_FAILED');
      expect(await prisma.fileAsset.count()).toBe(0);
    });

    it('refuses an upload past the unattached-file quota with 429', async () => {
      const user = await createRegularUser(app, 'hoarder@example.com');
      const expiresAt = new Date(Date.now() + 60_000);
      await prisma.fileAsset.createMany({
        data: Array.from({ length: 20 }, (_, index) => ({
          uploadedBy: user.id,
          purpose: 'profile_image',
          status: FileAssetStatus.READY,
          storageKey: `files/profile-images/quota-${index}.png`,
          kind: 'image',
          contentType: 'image/png',
          fileName: 'x.png',
          sizeBytes: 1,
          expiresAt,
        })),
      });

      const res = await upload(
        user.token,
        'profile_image',
        await buildPng(),
        'one-more.png',
      ).expect(429);
      expect(res.body).toMatchObject({
        errorCode: 'FILE_QUOTA_EXCEEDED',
        details: { limit: 20 },
      });
    });

    it('answers 503 and releases the row when storage refuses the write', async () => {
      const user = await createRegularUser(app, 'outage@example.com');
      storage.isPutFailing = true;

      const res = await upload(
        user.token,
        'profile_image',
        await buildPng(),
        'a.png',
      ).expect(503);
      expect(res.body.errorCode).toBe('EXTERNAL_SERVICE_UNAVAILABLE');

      const rows = await prisma.fileAsset.findMany();
      expect(rows.map((row) => row.status)).toEqual([FileAssetStatus.DELETING]);
    });
  });

  describe('DELETE /api/files/:id', () => {
    function release(token: string, fileId: string): request.Test {
      return request(app.getHttpServer())
        .delete(`/api/files/${fileId}`)
        .set('Authorization', `Bearer ${token}`);
    }

    async function uploaded(token: string): Promise<string> {
      const res = await upload(
        token,
        'profile_image',
        await buildPng(),
        'pick.png',
      ).expect(201);
      return (res.body as UploadedFileBody).id;
    }

    async function status(fileId: string): Promise<string | undefined> {
      return (await prisma.fileAsset.findUnique({ where: { id: fileId } }))
        ?.status;
    }

    it('releases the caller’s own unattached upload, and a repeat changes nothing', async () => {
      const user = await createRegularUser(app, 'release@example.com');
      const fileId = await uploaded(user.token);

      await release(user.token, fileId).expect(204);
      expect(await status(fileId)).toBe(FileAssetStatus.DELETING);
      const row = await prisma.fileAsset.findUniqueOrThrow({
        where: { id: fileId },
      });
      expect(row.expiresAt).toBeNull();

      await release(user.token, fileId).expect(204);
      expect(await status(fileId)).toBe(FileAssetStatus.DELETING);
    });

    it('releases an expired upload the cleanup job has not reached yet', async () => {
      const user = await createRegularUser(app, 'late@example.com');
      const fileId = await uploaded(user.token);
      await prisma.fileAsset.update({
        where: { id: fileId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      await release(user.token, fileId).expect(204);
      expect(await status(fileId)).toBe(FileAssetStatus.DELETING);
    });

    it('lets the cleanup job delete a released upload — object, then row', async () => {
      const user = await createRegularUser(app, 'gone@example.com');
      const fileId = await uploaded(user.token);
      const { storageKey } = await prisma.fileAsset.findUniqueOrThrow({
        where: { id: fileId },
      });

      await release(user.token, fileId).expect(204);
      expect(storage.objects.has(storageKey)).toBe(true);
      expect(await app.get(FileCleanupHandler).runOnce()).toMatchObject({
        deleted: 1,
        failed: 0,
      });
      expect(await status(fileId)).toBeUndefined();
      expect(storage.objects.has(storageKey)).toBe(false);

      // Once removed it is like any unknown id.
      const res = await release(user.token, fileId).expect(404);
      expect(res.body).toMatchObject({
        errorCode: 'RESOURCE_NOT_FOUND',
        details: { resource: 'File' },
      });
    });

    it('refuses the caller’s own attached file with 409 and leaves it attached', async () => {
      const user = await createRegularUser(app, 'attached@example.com');
      const fileId = await uploaded(user.token);
      await request(app.getHttpServer())
        .put('/api/users/me/profile-image')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ fileId: fileId })
        .expect(200);

      const res = await release(user.token, fileId).expect(409);
      expect(res.body.errorCode).toBe('FILE_NOT_RELEASABLE');
      expect(await status(fileId)).toBe(FileAssetStatus.ATTACHED);
    });

    it('refuses the caller’s own file still being processed with 409', async () => {
      const user = await createRegularUser(app, 'processing@example.com');
      const file = await prisma.fileAsset.create({
        data: {
          uploadedBy: user.id,
          purpose: 'profile_image',
          status: FileAssetStatus.PROCESSING,
          storageKey: 'files/profile-images/in-flight.png',
          kind: 'image',
          contentType: 'image/png',
          fileName: 'x.png',
          sizeBytes: 1,
        },
      });

      const res = await release(user.token, file.id).expect(409);
      expect(res.body.errorCode).toBe('FILE_NOT_RELEASABLE');
      expect(await status(file.id)).toBe(FileAssetStatus.PROCESSING);
    });

    // Whether an id exists, and in what state, is not disclosed to anyone who
    // did not upload it — so someone else's file in any state answers exactly
    // like an id that never existed, and is left as it was.
    it('answers someone else’s file, in any state, exactly like an unknown id', async () => {
      const owner = await createRegularUser(app, 'owner@example.com');
      const other = await createRegularUser(app, 'other@example.com');
      const ready = await uploaded(owner.token);
      const attached = await uploaded(owner.token);
      await request(app.getHttpServer())
        .put('/api/users/me/profile-image')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ fileId: attached })
        .expect(200);
      const released = await uploaded(owner.token);
      await release(owner.token, released).expect(204);

      const unknown = await release(
        other.token,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);
      // Everything but the per-request fields (path, request id, time).
      const comparable = (body: Record<string, unknown>) => ({
        statusCode: body.statusCode,
        errorCode: body.errorCode,
        message: body.message,
        details: body.details,
      });
      for (const fileId of [ready, attached, released]) {
        const res = await release(other.token, fileId).expect(404);
        expect(comparable(res.body as Record<string, unknown>)).toEqual(
          comparable(unknown.body as Record<string, unknown>),
        );
      }
      expect(await status(ready)).toBe(FileAssetStatus.READY);
      expect(await status(attached)).toBe(FileAssetStatus.ATTACHED);
    });

    it('refuses an id that is not a UUID, and an anonymous caller', async () => {
      const user = await createRegularUser(app, 'shape@example.com');
      const res = await release(user.token, 'not-a-uuid').expect(400);
      expect(res.body.errorCode).toBe('VALIDATION_FAILED');
      await request(app.getHttpServer())
        .delete('/api/files/00000000-0000-4000-8000-000000000000')
        .expect(401);
    });

    // A released upload stops counting only once the cleanup job removes it,
    // so uploading and releasing in a loop cannot outrun the cleanup job.
    it('counts a released upload toward the quota until the cleanup job removes it', async () => {
      const user = await createRegularUser(app, 'cycler@example.com');
      const expiresAt = new Date(Date.now() + 60_000);
      await prisma.fileAsset.createMany({
        data: Array.from({ length: 19 }, (_, index) => ({
          uploadedBy: user.id,
          purpose: 'profile_image',
          status: FileAssetStatus.READY,
          storageKey: `files/profile-images/held-${index}.png`,
          kind: 'image',
          contentType: 'image/png',
          fileName: 'x.png',
          sizeBytes: 1,
          expiresAt,
        })),
      });
      const twentieth = await uploaded(user.token);
      await release(user.token, twentieth).expect(204);

      const refused = await upload(
        user.token,
        'profile_image',
        await buildPng(),
        'again.png',
      ).expect(429);
      expect(refused.body.errorCode).toBe('FILE_QUOTA_EXCEEDED');

      await app.get(FileCleanupHandler).runOnce();
      await upload(
        user.token,
        'profile_image',
        await buildPng(),
        'again.png',
      ).expect(201);
    });

    // Of the files being deleted, only the uploader's recent releases count: a
    // file a resource let go of, an upload that was refused, and a release
    // from over an hour ago that storage keeps failing to delete never hold
    // the uploader's slots.
    it('counts only recent releases among the files being deleted', async () => {
      const user = await createRegularUser(app, 'reworker@example.com');
      const expiresAt = new Date(Date.now() + 60_000);
      const row = (index: string) => ({
        uploadedBy: user.id,
        purpose: 'profile_image',
        storageKey: `files/profile-images/rework-${index}.png`,
        kind: 'image',
        contentType: 'image/png',
        fileName: 'x.png',
      });
      await prisma.fileAsset.createMany({
        data: [
          ...Array.from(
            { length: MAX_UNATTACHED_FILES_PER_USER - 1 },
            (_, index) => ({
              ...row(`held-${index}`),
              status: FileAssetStatus.READY,
              sizeBytes: 1,
              expiresAt,
            }),
          ),
          // Replaced or removed from what showed it.
          {
            ...row('detached'),
            status: FileAssetStatus.DELETING,
            sizeBytes: 1,
            attachedAt: new Date(),
          },
          // Refused before it was ever stored.
          { ...row('refused'), status: FileAssetStatus.DELETING },
          // Released, uploaded over an hour ago, with storage
          // still refusing to delete it.
          {
            ...row('stuck'),
            status: FileAssetStatus.DELETING,
            sizeBytes: 1,
            deleteAttempts: 1,
            createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        ],
      });

      await upload(
        user.token,
        'profile_image',
        await buildPng(),
        'twentieth.png',
      ).expect(201);
    });
  });

  describe('cleanup job', () => {
    // A row in a given state with its object present in storage.
    async function seedFile(
      uploadedBy: string,
      status: FileAssetStatus,
      fields: { expiresAt?: Date | null; createdAt?: Date } = {},
    ): Promise<{ id: string; storageKey: string }> {
      const storageKey = `files/documents/${status}-${Math.random()}.pdf`;
      const file = await prisma.fileAsset.create({
        data: {
          uploadedBy,
          purpose: 'document',
          status,
          storageKey,
          kind: 'document',
          contentType: 'application/pdf',
          fileName: 'x.pdf',
          sizeBytes: 4,
          expiresAt:
            fields.expiresAt === undefined
              ? status === FileAssetStatus.READY
                ? new Date(Date.now() + 60_000)
                : null
              : fields.expiresAt,
          ...(fields.createdAt ? { createdAt: fields.createdAt } : {}),
        },
      });
      await storage.put(storageKey, {
        body: Buffer.from('%PDF'),
        contentType: 'application/pdf',
        contentDisposition: 'attachment',
        cacheControl: PRIVATE_OBJECT_CACHE_CONTROL,
      });
      return { id: file.id, storageKey };
    }

    it('deletes expired, abandoned and released files — object, then row — and nothing else', async () => {
      const user = await createRegularUser(app, 'cleanup@example.com');
      const expired = await seedFile(user.id, FileAssetStatus.READY, {
        expiresAt: new Date(Date.now() - 1_000),
      });
      const abandoned = await seedFile(user.id, FileAssetStatus.PROCESSING, {
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const released = await seedFile(user.id, FileAssetStatus.DELETING);
      const live = await seedFile(user.id, FileAssetStatus.READY);
      const inFlight = await seedFile(user.id, FileAssetStatus.PROCESSING);
      const attached = await seedFile(user.id, FileAssetStatus.ATTACHED);

      const result = await app.get(FileCleanupHandler).runOnce();
      expect(result).toEqual({ released: 2, deleted: 3, failed: 0 });

      const remaining = await prisma.fileAsset.findMany({
        select: { id: true },
      });
      expect(remaining.map((file) => file.id).sort()).toEqual(
        [live.id, inFlight.id, attached.id].sort(),
      );
      for (const gone of [expired, abandoned, released]) {
        expect(storage.objects.has(gone.storageKey)).toBe(false);
      }
      for (const kept of [live, inFlight, attached]) {
        expect(storage.objects.has(kept.storageKey)).toBe(true);
      }

      // Idempotent: a duplicate tick finds nothing to do.
      expect(await app.get(FileCleanupHandler).runOnce()).toEqual({
        released: 0,
        deleted: 0,
        failed: 0,
      });
    });

    // A file released while something still references it (a broken attach
    // site) is refused by the RESTRICT foreign key. That must cost that one
    // row a retry, not stop every run at it.
    it('keeps going past a released file that is still referenced', async () => {
      const user = await createRegularUser(app, 'stuck@example.com');
      const stuck = await seedFile(user.id, FileAssetStatus.DELETING);
      await prisma.user.update({
        where: { id: user.id },
        data: { profileImageFileAssetId: stuck.id },
      });
      const other = await seedFile(user.id, FileAssetStatus.DELETING);

      const result = await app.get(FileCleanupHandler).runOnce();
      expect(result).toMatchObject({ deleted: 1, failed: 1 });
      expect(
        await prisma.fileAsset.findUnique({ where: { id: other.id } }),
      ).toBeNull();
      const kept = await prisma.fileAsset.findUniqueOrThrow({
        where: { id: stuck.id },
      });
      expect(kept.deleteAttempts).toBe(1);
    });

    // Storage keeps failing: the run stops instead of spending the storage
    // timeout on every file in the batch.
    it('stops a run after repeated storage failures', async () => {
      const user = await createRegularUser(app, 'outage-run@example.com');
      for (let index = 0; index < 7; index += 1) {
        await seedFile(user.id, FileAssetStatus.DELETING);
      }
      storage.isDeleteFailing = true;

      const result = await app.get(FileCleanupHandler).runOnce();
      expect(result).toEqual({ released: 0, deleted: 0, failed: 5 });
      expect(storage.deleteAttempts).toHaveLength(5);
    });

    it('keeps a file whose object delete failed, and deletes it on a later run', async () => {
      const user = await createRegularUser(app, 'retry@example.com');
      const released = await seedFile(user.id, FileAssetStatus.DELETING);

      storage.isDeleteFailing = true;
      expect(await app.get(FileCleanupHandler).runOnce()).toEqual({
        released: 0,
        deleted: 0,
        failed: 1,
      });
      const kept = await prisma.fileAsset.findUniqueOrThrow({
        where: { id: released.id },
      });
      expect(kept).toMatchObject({
        status: FileAssetStatus.DELETING,
        deleteAttempts: 1,
        storageKey: released.storageKey,
      });

      storage.isDeleteFailing = false;
      expect(await app.get(FileCleanupHandler).runOnce()).toEqual({
        released: 0,
        deleted: 1,
        failed: 0,
      });
      expect(
        await prisma.fileAsset.findUnique({ where: { id: released.id } }),
      ).toBeNull();
      expect(storage.objects.has(released.storageKey)).toBe(false);
    });
  });
});
