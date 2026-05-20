import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { Errors } from '../errors/errors';

// Whitelist of mime types accepted by image-upload endpoints. Kept narrow
// on purpose — every additional type is one more renderer/decoder the
// downstream image pipeline has to handle safely.
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// 10 MB per file — generous for photography but bounded so a single
// runaway upload can't exhaust the API process's memory (memoryStorage
// keeps the buffer in RAM until we hand it to FileStorageService).
export const MAX_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024;

type FileFilterCb = (error: Error | null, acceptFile: boolean) => void;

function imageMimeFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: FileFilterCb,
): void {
  if (ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(
    Errors.badRequest(
      `Unsupported image type: ${file.mimetype}. Allowed: ${[...ALLOWED_IMAGE_MIME_TYPES].join(', ')}`,
    ),
    false,
  );
}

// Standard multer options bundle for image-upload endpoints. memoryStorage
// hands us a `buffer` per file which FileStorageService writes with a UUID
// filename — multer's own diskStorage is bypassed so we own the naming /
// path layout end-to-end.
//
// Usage:
//   @Post('upload')
//   @UseInterceptors(FilesInterceptor('files', 50, imageUploadOptions))
//   upload(@UploadedFiles() files: Express.Multer.File[]) {}
export const imageUploadOptions = {
  storage: memoryStorage(),
  fileFilter: imageMimeFilter,
  limits: { fileSize: MAX_IMAGE_FILE_SIZE_BYTES },
};
