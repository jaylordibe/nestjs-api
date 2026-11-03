import sharp from 'sharp';
import { FileKind } from '../../common/enums/file-kind.enum';
import { FilePurpose } from '../../common/enums/file-purpose.enum';
import { ErrorCode } from '../../common/errors/error-code.enum';
import {
  buildHtml,
  buildJpegWithExif,
  buildOfficeDocument,
  buildPdf,
  buildPlainZip,
  buildPng,
  buildPngDeclaring,
  buildTruncatedPng,
} from '../../../test/fixtures/files';
import { FILE_PURPOSE_POLICIES } from './file-purpose.policy';
import { FileProcessor } from './file-processor';

// Runs the REAL decoder (sharp/libvips) and the real content sniffer: the
// properties under test — metadata gone, bombs refused before decode, content
// decided by bytes not by labels — only exist in those libraries' behaviour.
const MAX_PIXELS = 40_000_000;

// Awaits a rejection and returns the `errorCode` it carries.
async function rejectionCode(promise: Promise<unknown>): Promise<unknown> {
  const error: unknown = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  return (
    error as { getResponse?: () => { errorCode?: string } } | undefined
  )?.getResponse?.()?.errorCode;
}

describe('FileProcessor', () => {
  const processor = new FileProcessor(MAX_PIXELS);
  const profileImage = FILE_PURPOSE_POLICIES[FilePurpose.PROFILE_IMAGE];
  const documents = FILE_PURPOSE_POLICIES[FilePurpose.DOCUMENT];

  describe('identify', () => {
    it.each([
      ['a PNG', buildPng, 'image/png'],
      ['a PDF', () => Promise.resolve(buildPdf()), 'application/pdf'],
      [
        'a DOCX',
        () => Promise.resolve(buildOfficeDocument('docx')),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
    ])('recognises %s by its bytes', async (_label, build, contentType) => {
      const accepted = await processor.identify(await build(), documents);
      expect(accepted.contentType).toBe(contentType);
    });

    // A client labels its part `image/png`; the bytes are an HTML page.
    it('refuses content no signature identifies (HTML posing as an image)', async () => {
      expect(
        await rejectionCode(processor.identify(buildHtml(), documents)),
      ).toBe(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
    });

    it('refuses an identified type the purpose does not accept', async () => {
      expect(
        await rejectionCode(processor.identify(buildPdf(), profileImage)),
      ).toBe(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
      expect(
        await rejectionCode(processor.identify(buildPlainZip(), documents)),
      ).toBe(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
    });
  });

  describe('process', () => {
    it('re-encodes an image and strips its EXIF and GPS metadata', async () => {
      const original = await buildJpegWithExif(64, 48);
      expect((await sharp(original).metadata()).exif).toBeDefined();

      const accepted = await processor.identify(original, profileImage);
      const processed = await processor.process(
        original,
        accepted,
        profileImage,
      );

      const metadata = await sharp(processed.body).metadata();
      expect(metadata.format).toBe('jpeg');
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(processed).toMatchObject({ width: 64, height: 48 });
      expect(processed.body.equals(original)).toBe(false);
    });

    it('scales an image down to the purpose limit, never up', async () => {
      const large = await buildPng(2048, 1024);
      const accepted = await processor.identify(large, profileImage);
      const processed = await processor.process(large, accepted, profileImage);
      expect(processed).toMatchObject({ width: 1024, height: 512 });

      const small = await buildPng(10, 10);
      const smallProcessed = await processor.process(
        small,
        await processor.identify(small, profileImage),
        profileImage,
      );
      expect(smallProcessed).toMatchObject({ width: 10, height: 10 });
    });

    // The configured cap is what refuses: a real, decodable 64 × 48 image
    // (3072 px) is refused one pixel under it and accepted exactly at it.
    it('applies the configured pixel cap to a decodable image', async () => {
      const image = await buildPng(64, 48);
      const accepted = await processor.identify(image, profileImage);

      expect(
        await rejectionCode(
          new FileProcessor(64 * 48 - 1).process(image, accepted, profileImage),
        ),
      ).toBe(ErrorCode.FILE_CONTENT_INVALID);
      await expect(
        new FileProcessor(64 * 48).process(image, accepted, profileImage),
      ).resolves.toMatchObject({ width: 64, height: 48 });
    });

    // A few dozen bytes declaring 20000 × 20000, with no pixel data at all.
    // Refused without decoding — by the cap, by libvips' own ceiling, or by the
    // empty stream; this pins the outcome, the test above pins the cap.
    it('refuses a header-only image declaring enormous dimensions', async () => {
      const bomb = buildPngDeclaring(20_000, 20_000);
      const accepted = await processor.identify(bomb, profileImage);
      expect(
        await rejectionCode(processor.process(bomb, accepted, profileImage)),
      ).toBe(ErrorCode.FILE_CONTENT_INVALID);
    });

    it('refuses an image that does not decode', async () => {
      const truncated = await buildTruncatedPng();
      const accepted = await processor.identify(truncated, profileImage);
      expect(
        await rejectionCode(
          processor.process(truncated, accepted, profileImage),
        ),
      ).toBe(ErrorCode.FILE_CONTENT_INVALID);
    });

    // A type a policy accepts with no encoder is a programming error: it must
    // not be reported as the client's bad file (422), nor stored unprocessed.
    it('fails loudly for an image type with no encoder', async () => {
      const gif = {
        contentType: 'image/gif',
        kind: FileKind.IMAGE,
        extension: 'gif',
      };
      const error: unknown = await processor
        .process(await buildPng(), gif, profileImage)
        .then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
      expect(error).toBeInstanceOf(Error);
      expect((error as { getResponse?: unknown }).getResponse).toBeUndefined();
    });

    it('stores a document byte-for-byte', async () => {
      const pdf = buildPdf();
      const accepted = await processor.identify(pdf, documents);
      const processed = await processor.process(pdf, accepted, documents);
      expect(accepted.kind).toBe(FileKind.DOCUMENT);
      expect(processed.body.equals(pdf)).toBe(true);
      expect(processed).toMatchObject({ width: null, height: null });
    });
  });
});
