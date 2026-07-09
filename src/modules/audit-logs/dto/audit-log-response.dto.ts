import { AuditLog, Prisma } from '@prisma/client';

export class AuditLogResponseDto {
  id!: string;
  createdAt!: Date;
  actorId!: string | null;
  targetUserId!: string | null;
  action!: string;
  // Server-vouched request envelope (requestId, ip, userAgent, parsed
  // browser/os/device, Cloudflare country) merged in by AuditService.
  metadata!: Prisma.JsonValue;

  constructor(row: AuditLog) {
    Object.assign(this, row);
  }
}
