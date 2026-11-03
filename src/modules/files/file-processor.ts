import { Logger } from '@nestjs/common';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { FileKind } from '../../common/enums/file-kind.enum';
import { Errors } from '../../common/errors/errors';
import {
  createConcurrencyLimit,
  type ConcurrencyLimit,
} from '../../common/util/concurrency-limit.util';
import { formatErrorMessage } from '../../common/util/error-message.util';
import type {
  AcceptedContentType,
  FilePurposePolicy,
} from './file-purpose.policy';

// libvips keeps decoded images in an in-process cache by default. Uploads are
// never decoded twice, so the cache only holds memory.
sharp.cache(false);

// Image re-encodes running at once in this process. A decoded image costs its
// pixel count in NATIVE memory (~200 MB at the 40 MP default, measured in
// node:24-alpine; outside the V8 heap), so a burst of small uploads
// declaring large dimensions would otherwise hold several of those at once.
// Further uploads wait; their raw bytes are already bounded by the multer cap.
const MAX_CONCURRENT_IMAGE_REENCODES = 2;

export interface ProcessedFile {
  body: Buffer;
  width: number | null;
  height: number | null;
}

// Decides what an uploaded file IS, and turns it into the bytes that get stored.
//
// Nothing a client says about the file is used: not the multipart part's
// `Content-Type`, not the file name's extension. The type is identified from
// the bytes (magic numbers, and for Office files the parts inside the ZIP
// container), and must be one the purpose accepts.
//
// Images are decoded and re-encoded. That is the control, not a cosmetic step:
// the stored bytes are produced by the encoder, so a polyglot or a malformed
// payload aimed at some later decoder does not survive, and EXIF / GPS / ICC
// metadata is dropped because the encoder is never asked to write it. The pixel
// count is checked from the header before anything is decoded.
//
// Documents are stored byte-for-byte: there is no sanitiser for PDF or Office
// content in this template, so they are only ever served as downloads.
//
// Runs outside any database transaction, by design: decoding is CPU work on
// libuv's thread pool and must never hold a connection.
export class FileProcessor {
  private readonly logger = new Logger(FileProcessor.name);
  private readonly limitReencodes: ConcurrencyLimit = createConcurrencyLimit(
    MAX_CONCURRENT_IMAGE_REENCODES,
  );

  constructor(private readonly maxImagePixels: number) {}

  async identify(
    body: Buffer,
    policy: FilePurposePolicy,
  ): Promise<AcceptedContentType> {
    const detected = await fileTypeFromBuffer(body);
    const accepted = detected ? policy.accepted.get(detected.mime) : undefined;
    if (!accepted) {
      throw Errors.unsupportedMediaType(
        `This file type is not accepted here. Accepted: ${[
          ...policy.accepted.values(),
        ]
          .map((type) => type.extension)
          .join(', ')}.`,
      );
    }
    return accepted;
  }

  async process(
    body: Buffer,
    accepted: AcceptedContentType,
    policy: FilePurposePolicy,
  ): Promise<ProcessedFile> {
    if (accepted.kind === FileKind.DOCUMENT) {
      return { body, width: null, height: null };
    }
    return this.limitReencodes(() =>
      this.reencodeImage(body, accepted, policy),
    );
  }

  private async reencodeImage(
    body: Buffer,
    accepted: AcceptedContentType,
    policy: FilePurposePolicy,
  ): Promise<ProcessedFile> {
    // `limitInputPixels` makes libvips refuse an over-large image from its
    // header, before any pixel is allocated. `failOn: 'error'` refuses a
    // truncated or corrupt image instead of decoding what it can of it.
    const options: sharp.SharpOptions = {
      limitInputPixels: this.maxImagePixels,
      failOn: 'error',
    };
    // Chosen before the `try`: a type with no encoder is a programming error
    // and must surface as one, not as the client's bad file.
    const encode = this.encoderFor(accepted.contentType);
    try {
      const pipeline = sharp(body, options)
        // Bake the EXIF orientation into the pixels before the EXIF is gone,
        // or a portrait phone photo is stored sideways.
        .rotate()
        .resize({
          width: policy.imageMaxDimension,
          height: policy.imageMaxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        });
      // Same format out as in: the client chose it, and the purpose accepts
      // it. No `withMetadata()`/`keepMetadata()` call anywhere — that absence
      // is what strips the metadata.
      const encoded = encode(pipeline);
      const { data, info } = await encoded.toBuffer({
        resolveWithObject: true,
      });
      return { body: data, width: info.width, height: info.height };
    } catch (error) {
      // The decoder's own message stays in the log; the client gets a fixed
      // one. Never the original file name — it is user content.
      this.logger.warn(
        `Image refused while processing: ${formatErrorMessage(error)}`,
      );
      throw Errors.fileContentInvalid(
        'The image could not be processed. It may be damaged, or larger than allowed.',
      );
    }
  }

  private encoderFor(
    contentType: string,
  ): (pipeline: sharp.Sharp) => sharp.Sharp {
    switch (contentType) {
      case 'image/jpeg':
        return (pipeline) => pipeline.jpeg({ quality: 85, mozjpeg: true });
      case 'image/png':
        return (pipeline) => pipeline.png({ compressionLevel: 9 });
      case 'image/webp':
        return (pipeline) => pipeline.webp({ quality: 85 });
      default:
        // Unreachable while every image type in FILE_PURPOSE_POLICIES has a
        // case above; a new one without a case must fail loudly, not be
        // stored un-re-encoded.
        throw new Error(`No image encoder for ${contentType}`);
    }
  }
}
