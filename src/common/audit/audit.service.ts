import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  actorId: string | null;
  targetUserId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

// Append-only record of privileged/security-relevant actions. Writes are
// best-effort: a failed audit write is logged but never blocks the
// business operation that triggered it.
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorId: entry.actorId,
          targetUserId: entry.targetUserId,
          metadata: entry.metadata,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write audit log for action ${entry.action}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
