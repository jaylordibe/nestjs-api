import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService, ClsStore } from 'nestjs-cls';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  actorId: string | null;
  targetUserId?: string | null;
  // Typed as `InputJsonObject` (not the broader `InputJsonValue` union) so
  // the spread in `mergeRequestContext` is type-safe. Every caller already
  // passes an object literal; this just makes the contract explicit.
  metadata?: Prisma.InputJsonObject;
}

// Per-request fields the AppModule CLS middleware stashes on every HTTP
// request (see `ClsModule.forRoot` in `app.module.ts`). All optional because
// cron-driven and bootstrap callsites invoke `AuditService.record` outside any
// HTTP context — those are handled by the `cls.isActive()` short-circuit.
// Empty fields (e.g. CF headers absent in local dev, parsed UA empty for
// non-browser UAs) are skipped by the merge so the envelope is never noisy.
export interface RequestContextStore extends ClsStore {
  // Tier 1 — always available where an HTTP request is in flight.
  ip?: string;
  userAgent?: string;
  acceptLanguage?: string;
  method?: string;
  path?: string;
  browser?: { name: string; version?: string };
  os?: { name: string; version?: string };
  device?: { type?: string; vendor?: string; model?: string };
  // Tier 2 — populated only behind Cloudflare.
  country?: string;
  cfRay?: string;
}

// Append-only record of privileged/security-relevant actions. Writes are
// best-effort: a failed audit write is logged but never blocks the business
// operation that triggered it.
//
// Every entry written from an HTTP request gets a `metadata.request` envelope
// auto-populated with ip / userAgent / requestId / method / path (+ parsed
// browser/os/device and Cloudflare country/ray when present). Cron / bootstrap
// / script-driven calls (no request context) skip the envelope cleanly — see
// `mergeRequestContext`.
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContextStore>,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      const metadata = this.mergeRequestContext(entry.metadata);
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorId: entry.actorId,
          targetUserId: entry.targetUserId,
          metadata,
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

  // Caller's `request` key (if any) is intentionally overwritten — the audit
  // context must be server-vouched, not client-influenced. Every other
  // caller-supplied key passes through untouched. Empty CLS values (CF headers
  // absent locally, parsed UA pieces missing for a non-browser UA, etc.) are
  // skipped so the envelope only contains fields with real content — no
  // `country: ''` placeholders.
  private mergeRequestContext(
    metadata: Prisma.InputJsonObject | undefined,
  ): Prisma.InputJsonObject | undefined {
    if (!this.cls.isActive()) {
      return metadata;
    }
    const stash = {
      ip: this.cls.get('ip'),
      userAgent: this.cls.get('userAgent'),
      acceptLanguage: this.cls.get('acceptLanguage'),
      country: this.cls.get('country'),
      cfRay: this.cls.get('cfRay'),
      browser: this.cls.get('browser'),
      os: this.cls.get('os'),
      device: this.cls.get('device'),
      requestId: this.cls.getId(),
      method: this.cls.get('method'),
      path: this.cls.get('path'),
    };
    // Build as a mutable Record first — `Prisma.InputJsonObject` has a
    // readonly index signature, so assigning into it directly is a TS2542.
    // Spreading into the outer object copies the entries through the
    // value-side, which is fine.
    const request: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, value] of Object.entries(stash)) {
      if (value !== undefined && value !== null && value !== '') {
        request[key] = value as Prisma.InputJsonValue;
      }
    }
    if (Object.keys(request).length === 0) {
      return metadata;
    }
    return { ...(metadata ?? {}), request };
  }
}
