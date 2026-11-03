import { HttpException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileAsset, Prisma } from '@prisma/client';
import { FileAssetStatus } from '../../common/enums/file-asset-status.enum';
import { FileKind } from '../../common/enums/file-kind.enum';
import { FilePurpose } from '../../common/enums/file-purpose.enum';
import { Errors } from '../../common/errors/errors';
import { FileStorageService } from '../../common/storage/file-storage.service';
import { buildContentDisposition } from '../../common/util/content-disposition.util';
import { formatErrorMessage } from '../../common/util/error-message.util';
import { sanitizeFileName } from '../../common/util/file-name.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AttachedFileResponseDto } from './dto/attached-file-response.dto';
import { FileProcessor } from './file-processor';
import {
  FILE_PURPOSE_POLICIES,
  MAX_UNATTACHED_FILES_PER_USER,
} from './file-purpose.policy';

export interface UploadedFileInput {
  buffer: Buffer;
  size: number;
  originalname: string;
}

export interface AttachFileInput {
  fileId: string;
  actorId: string;
  purpose: FilePurpose;
}

// A `processing` row older than this belongs to a request that died between
// writing the row and finishing; no live upload takes anywhere near this long.
const STALE_PROCESSING_MILLISECONDS = 15 * 60 * 1000;
// Objects deleted per cleanup run. Bounded so one run's duration is too; the
// next run picks up the rest.
const CLEANUP_BATCH_SIZE = 200;
// Past this many failed deletes a file is logged as an error on every run, so
// a stuck object is visible rather than retried silently forever.
const DELETE_ATTEMPTS_ALERT_THRESHOLD = 5;
// A run stops starting deletes after this long, and after this many storage
// failures in a row: a slow or failing bucket must not hold a maintenance
// queue slot (shared with the worker heartbeat) for the length of the batch
// times the storage timeout. The next run continues where this one stopped.
const CLEANUP_TIME_BUDGET_MILLISECONDS = 2 * 60 * 1000;
const CLEANUP_CONSECUTIVE_FAILURE_LIMIT = 5;

export interface CleanupResult {
  released: number;
  deleted: number;
  failed: number;
}

const UNATTACHED_STATUSES = [
  FileAssetStatus.PROCESSING,
  FileAssetStatus.READY,
] as const;

// The shared file capability: ingest, attach, sign, and release. It knows no
// resource — a domain service owns the column or table that references a file,
// and calls `claimForAttachment` / `markDeleting` inside ITS transaction, so
// the reference and the file's state change together.
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly maxUploadBytes: number;
  private readonly uploadTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
    private readonly processor: FileProcessor,
    configService: ConfigService,
  ) {
    this.maxUploadBytes = configService.getOrThrow<number>(
      'files.maxUploadBytes',
    );
    this.uploadTtlSeconds = configService.getOrThrow<number>(
      'files.uploadTtlSeconds',
    );
  }

  /**
   * Phase one: validate, process and store one file for `actorId`, and return
   * its `ready` row. Every step that touches storage or decodes bytes runs
   * outside a transaction; the row is written first, so an object never exists
   * without a row that names it.
   */
  async upload(
    file: UploadedFileInput,
    purpose: FilePurpose,
    actorId: string,
  ): Promise<FileAsset> {
    const policy = FILE_PURPOSE_POLICIES[purpose];
    const maxBytes = Math.min(policy.maxBytes, this.maxUploadBytes);
    if (file.size > maxBytes) {
      throw Errors.payloadTooLarge(
        `This file is larger than the ${maxBytes} bytes allowed here.`,
      );
    }

    // Counted, not locked: two simultaneous uploads can both pass at the
    // limit. The route's throttle bounds that overshoot, and every one of
    // these files expires anyway.
    const unattachedCount = await this.prisma.fileAsset.count({
      where: { uploadedBy: actorId, status: { in: [...UNATTACHED_STATUSES] } },
    });
    if (unattachedCount >= MAX_UNATTACHED_FILES_PER_USER) {
      throw Errors.fileQuotaExceeded(MAX_UNATTACHED_FILES_PER_USER);
    }

    const accepted = await this.processor.identify(file.buffer, policy);
    const storageKey = this.storage.createKey(
      policy.storageSubdirectory,
      `.${accepted.extension}`,
    );
    const fileName = sanitizeFileName(file.originalname, accepted.extension);

    const row = await this.prisma.fileAsset.create({
      data: {
        uploadedBy: actorId,
        purpose,
        status: FileAssetStatus.PROCESSING,
        storageKey,
        kind: accepted.kind,
        contentType: accepted.contentType,
        fileName,
      },
    });

    let processed: Awaited<ReturnType<FileProcessor['process']>>;
    try {
      processed = await this.processor.process(file.buffer, accepted, policy);
    } catch (error) {
      await this.releaseFailedUpload(row.id);
      throw error instanceof HttpException
        ? error
        : Errors.fileContentInvalid('The file could not be processed.');
    }

    try {
      await this.storage.put(storageKey, {
        body: processed.body,
        contentType: accepted.contentType,
        contentDisposition: buildContentDisposition(
          accepted.kind === FileKind.IMAGE ? 'inline' : 'attachment',
          fileName,
        ),
        cacheControl: policy.cacheControl,
      });
    } catch (error) {
      this.logger.error(
        `Storing file ${row.id} failed: ${formatErrorMessage(error)}`,
      );
      // The write may have partly happened; the cleanup job deletes the key.
      await this.releaseFailedUpload(row.id);
      throw Errors.externalServiceUnavailable(
        'File storage is unavailable. Please try again.',
      );
    }

    const expiresAt = new Date(Date.now() + this.uploadTtlSeconds * 1000);
    // Conditional: if the cleanup job reclaimed a stalled `processing` row in
    // the meantime, this upload has lost and must not resurrect it.
    const finished = await this.prisma.fileAsset.updateMany({
      where: { id: row.id, status: FileAssetStatus.PROCESSING },
      data: {
        status: FileAssetStatus.READY,
        sizeBytes: processed.body.length,
        width: processed.width,
        height: processed.height,
        expiresAt,
      },
    });
    if (finished.count !== 1) {
      // The row was released while this request was still working (the
      // cleanup job reclaimed a stale upload, or the account was erased) and
      // may already be gone with its key — so this request removes the object
      // it just wrote, or nothing ever would.
      await this.storage.delete(storageKey).catch((error: unknown) => {
        this.logger.error(
          `Removing the object of released file ${row.id} failed: ${formatErrorMessage(error)}`,
        );
      });
      throw Errors.externalServiceUnavailable(
        'The upload took too long. Please try again.',
      );
    }
    return this.prisma.fileAsset.findUniqueOrThrow({ where: { id: row.id } });
  }

  /**
   * Phase two: consume a `ready` file for an attach site, inside the caller's
   * transaction. One conditional UPDATE decides it — the file must be the
   * actor's own, for this purpose, `ready` and unexpired — so an id is consumed
   * exactly once, and an attach racing the cleanup job's claim cannot both win.
   *
   * Someone else's file, or one uploaded for another purpose, is 404: whether
   * an id exists is not disclosed to anyone who could not attach it.
   */
  async claimForAttachment(
    transaction: Prisma.TransactionClient,
    { fileId, actorId, purpose }: AttachFileInput,
  ): Promise<FileAsset> {
    const now = new Date();
    const claimed = await transaction.fileAsset.updateMany({
      where: {
        id: fileId,
        uploadedBy: actorId,
        purpose,
        status: FileAssetStatus.READY,
        expiresAt: { gt: now },
      },
      data: {
        status: FileAssetStatus.ATTACHED,
        attachedAt: now,
        expiresAt: null,
      },
    });
    if (claimed.count === 1) {
      return transaction.fileAsset.findUniqueOrThrow({ where: { id: fileId } });
    }

    const ownFile = await transaction.fileAsset.findFirst({
      where: { id: fileId, uploadedBy: actorId, purpose },
      select: { id: true },
    });
    if (!ownFile) {
      throw Errors.resourceNotFound('File');
    }
    throw Errors.fileNotAttachable();
  }

  /**
   * Releases files a resource no longer references, inside the caller's
   * transaction. **The caller must clear its reference in that same
   * transaction**: the cleanup job deletes a released file's object before its
   * row, so a file released while still referenced loses its bytes.
   */
  async markDeleting(
    transaction: Prisma.TransactionClient,
    fileIds: string[],
  ): Promise<void> {
    if (fileIds.length === 0) return;
    await transaction.fileAsset.updateMany({
      where: { id: { in: fileIds }, status: { not: FileAssetStatus.DELETING } },
      data: { status: FileAssetStatus.DELETING, expiresAt: null },
    });
  }

  /**
   * Releases every file `uploaderId` uploaded but never attached. Used by
   * account erasure; attached files are released by whoever references them.
   */
  async markUnattachedDeleting(
    transaction: Prisma.TransactionClient,
    uploaderId: string,
  ): Promise<void> {
    await transaction.fileAsset.updateMany({
      where: {
        uploadedBy: uploaderId,
        status: { in: [...UNATTACHED_STATUSES] },
      },
      data: { status: FileAssetStatus.DELETING, expiresAt: null },
    });
  }

  /**
   * Response shapes for attached files, by id, each with a fresh signed URL.
   *
   * **Call only for files belonging to records the caller was authorized to
   * read** — each URL is a bearer credential. Only `attached` files are
   * served; an id that is missing, released or still in flight is absent from
   * the map.
   *
   * Never throws for a signing failure. These URLs decorate responses that
   * are built AFTER other work has committed — a login, a token rotation, a
   * credential change — and a storage outage must cost a missing picture, not
   * the tokens that work already issued. A failed signature is logged and the
   * file left out.
   */
  async findAttachedResponses(
    fileIds: string[],
  ): Promise<Map<string, AttachedFileResponseDto>> {
    const responses = new Map<string, AttachedFileResponseDto>();
    if (fileIds.length === 0) return responses;
    let files: FileAsset[];
    try {
      files = await this.prisma.fileAsset.findMany({
        where: { id: { in: fileIds }, status: FileAssetStatus.ATTACHED },
      });
    } catch (error) {
      // Same rule as a failed signature: the caller's committed work must not
      // be lost to a lookup that only decorates its response.
      this.logger.error(
        `Loading attached files failed; they are left out of the response: ${formatErrorMessage(error)}`,
      );
      return responses;
    }
    await Promise.all(
      files.map(async (file) => {
        try {
          const { url, expiresAt } = await this.storage.createSignedReadUrl(
            file.storageKey,
          );
          responses.set(
            file.id,
            new AttachedFileResponseDto({
              id: file.id,
              contentType: file.contentType,
              width: file.width,
              height: file.height,
              url,
              urlExpiresAt: expiresAt,
            }),
          );
        } catch (error) {
          this.logger.error(
            `Signing a read URL for file ${file.id} failed; it is left out of the response: ${formatErrorMessage(error)}`,
          );
        }
      }),
    );
    return responses;
  }

  /**
   * The cleanup job's work, in two steps:
   *
   * 1. CLAIM: every `ready` file past `expiresAt`, and every `processing` row
   *    a dead request left behind, moves to `deleting` in one conditional
   *    UPDATE. An attach is the same kind of UPDATE on the same row, so
   *    whichever commits first wins and the other matches nothing.
   * 2. DELETE: for a bounded batch of `deleting` rows, delete the object, then
   *    the row. A failed object delete keeps the row (and its key) and counts
   *    the attempt; the next run retries it. The row delete is conditional on
   *    `deleting`. The RESTRICT foreign keys protect the ROW, not the object:
   *    the guarantee that a `deleting` file is referenced by nothing comes from
   *    every `markDeleting` caller clearing its reference in the same
   *    transaction. A run is bounded in time and stops early when storage keeps
   *    failing.
   *
   * Idempotent: a duplicate run finds the claims made and the objects gone, and
   * deleting an object that is already gone succeeds.
   */
  async cleanUp(now: Date = new Date()): Promise<CleanupResult> {
    const claimed = await this.prisma.fileAsset.updateMany({
      where: {
        OR: [
          { status: FileAssetStatus.READY, expiresAt: { lte: now } },
          {
            status: FileAssetStatus.PROCESSING,
            createdAt: {
              lt: new Date(now.getTime() - STALE_PROCESSING_MILLISECONDS),
            },
          },
        ],
      },
      data: { status: FileAssetStatus.DELETING, expiresAt: null },
    });

    // Fewest attempts first, so files storage keeps refusing cannot starve
    // the rest of the queue.
    const batch = await this.prisma.fileAsset.findMany({
      where: { status: FileAssetStatus.DELETING },
      orderBy: [{ deleteAttempts: 'asc' }, { updatedAt: 'asc' }],
      take: CLEANUP_BATCH_SIZE,
      select: { id: true, storageKey: true, deleteAttempts: true },
    });

    const startedAt = Date.now();
    let deleted = 0;
    let failed = 0;
    let consecutiveFailures = 0;
    for (const file of batch) {
      if (
        Date.now() - startedAt > CLEANUP_TIME_BUDGET_MILLISECONDS ||
        consecutiveFailures >= CLEANUP_CONSECUTIVE_FAILURE_LIMIT
      ) {
        break;
      }
      try {
        await this.storage.delete(file.storageKey);
        // Caught here rather than left to the global filter, because this is a
        // job loop, not a request: one row the RESTRICT foreign keys refuse
        // (something still references it — a broken `markDeleting` caller)
        // must be counted and logged, not abort every run at the same row.
        const removed = await this.prisma.fileAsset.deleteMany({
          where: { id: file.id, status: FileAssetStatus.DELETING },
        });
        deleted += removed.count;
        consecutiveFailures = 0;
      } catch (error) {
        failed += 1;
        consecutiveFailures += 1;
        await this.recordFailedDelete(file, error);
      }
    }

    return { released: claimed.count, deleted, failed };
  }

  private async recordFailedDelete(
    file: { id: string; deleteAttempts: number },
    error: unknown,
  ): Promise<void> {
    await this.prisma.fileAsset.updateMany({
      where: { id: file.id, status: FileAssetStatus.DELETING },
      data: { deleteAttempts: { increment: 1 } },
    });
    const attempts = file.deleteAttempts + 1;
    const message = `Deleting file ${file.id} failed (attempt ${attempts}); it will be retried: ${formatErrorMessage(error)}`;
    if (attempts >= DELETE_ATTEMPTS_ALERT_THRESHOLD) {
      this.logger.error(message);
    } else {
      this.logger.warn(message);
    }
  }

  private async releaseFailedUpload(fileId: string): Promise<void> {
    await this.prisma.fileAsset.updateMany({
      where: { id: fileId, status: FileAssetStatus.PROCESSING },
      data: { status: FileAssetStatus.DELETING },
    });
  }
}
