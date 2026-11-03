import { Injectable, Logger } from '@nestjs/common';
import { JobName } from '../../common/queue/job-registry';
import {
  RegisterQueueJobHandler,
  type QueueJobHandler,
} from '../../common/queue/queue-job-handler';
import {
  completedJob,
  type JobOutcome,
} from '../../common/queue/queue-job-outcome';
import { FileCleanupPayloadDto } from './dto/file-cleanup-payload.dto';
import { FilesService, type CleanupResult } from './files.service';

/**
 * Deletes files nothing uses: uploads never attached before they expired,
 * uploads a crashed request left half-done, and files a resource let go of
 * (replaced, removed, or its owner's account erased).
 *
 * A recurring BullMQ job (`recurring-schedule-registry.ts`), so it runs once
 * per tick however many workers there are. A failed object delete is not a
 * job failure: the row stays `deleting` and the next tick retries it, so the
 * job's own retry policy only covers the database being unreachable.
 */
@Injectable()
@RegisterQueueJobHandler()
export class FileCleanupHandler implements QueueJobHandler<FileCleanupPayloadDto> {
  readonly jobName = JobName.FILES_CLEANUP_V1;
  readonly payloadType = FileCleanupPayloadDto;

  private readonly logger = new Logger(FileCleanupHandler.name);

  constructor(private readonly filesService: FilesService) {}

  async handle(): Promise<JobOutcome> {
    const result = await this.runOnce();
    return completedJob(
      result.deleted + result.failed > 0
        ? `deleted ${result.deleted} file(s), ${result.failed} to retry`
        : undefined,
    );
  }

  // The testable seam: drivable directly from a spec or a runbook.
  async runOnce(now?: Date): Promise<CleanupResult> {
    const result = await this.filesService.cleanUp(now);
    if (result.released + result.deleted + result.failed > 0) {
      this.logger.log(
        `Released ${result.released}, deleted ${result.deleted}, ${result.failed} delete(s) to retry`,
      );
    }
    return result;
  }
}
