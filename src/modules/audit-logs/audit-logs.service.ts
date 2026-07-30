import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildOrderBy, SortOrder } from '../../common/dto/meta-query.dto';
import { PaginationMeta } from '../../common/dto/paginated-response.dto';
import { Errors } from '../../common/errors/errors';
import { buildDateRangeFilter } from '../../common/util/date-range.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { AuditLogRow, AuditLogUserRef } from './dto/audit-log-response.dto';

const AUDIT_LOG_SORTABLE_COLUMNS = ['createdAt', 'action'] as const;

// Read-only. Audit rows are written by `AuditService` and never edited or
// deleted through the API — an audit trail you can mutate is not an audit
// trail. Retention is a separate, deliberate operation.
//
// The composite indexes this relies on — (actorId, createdAt),
// (targetUserId, createdAt), (action, createdAt), (createdAt) — plus the
// trigram GIN index on `metadata::text` that backs `?search=`, are all declared
// in the init migration.
@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async findPaginated(
    query: AuditLogQueryDto,
  ): Promise<{ data: AuditLogRow[]; meta: PaginationMeta }> {
    const { page, perPage } = query;
    const where = await this.buildFilter(query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: buildOrderBy(
          query,
          AUDIT_LOG_SORTABLE_COLUMNS,
          'createdAt',
          SortOrder.DESC,
        ),
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      // Same `where` on both calls so `meta.total` reflects the filtered set,
      // not the whole table.
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      data: await this.hydrateUserRefs(rows),
      meta: { page, perPage, total, totalPages: Math.ceil(total / perPage) },
    };
  }

  async findById(id: string): Promise<AuditLogRow> {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) {
      throw Errors.resourceNotFound('Audit log');
    }
    const [hydrated] = await this.hydrateUserRefs([row]);
    return hydrated;
  }

  // Resolves `actor` + `targetUser` for a whole page in ONE query, not one per
  // row. `audit_logs` carries no FK to `users` — deliberately, so an audit row
  // outlives everyone it names — which also means Prisma has no relation to
  // `include` and the referenced users must be batch-fetched.
  //
  // Raw `this.prisma.user`, NOT `prisma.scoped.user`: soft-deleted users must
  // still render, or the trail goes anonymous exactly when someone is
  // investigating a closed or erased account. They show their last-known
  // identity, which is the entire point of an audit log.
  private async hydrateUserRefs(rows: AuditLogRow[]): Promise<AuditLogRow[]> {
    const referencedUserIds = new Set<string>();
    for (const auditLog of rows) {
      if (auditLog.actorId) referencedUserIds.add(auditLog.actorId);
      if (auditLog.targetUserId) referencedUserIds.add(auditLog.targetUserId);
    }
    if (referencedUserIds.size === 0) {
      return rows.map((auditLog) => ({
        ...auditLog,
        actor: null,
        targetUser: null,
      }));
    }

    // Roles ride along on the SAME query as a nested select, not a second
    // round trip. No `scope` filter is needed: a CHECK constraint in the init
    // migration makes it impossible for `user_roles` to reference anything but
    // a PLATFORM role, so filtering here would be re-stating a database
    // guarantee. Business memberships live in `business_members` and are
    // deliberately not surfaced — a tenant-local role name means nothing
    // without saying which business it belongs to.
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...referencedUserIds] } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    const userById = new Map<string, AuditLogUserRef>(
      users.map((user) => [
        user.id,
        {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          roles: user.userRoles.map((userRole) => userRole.role.name),
        },
      ]),
    );

    return rows.map((auditLog) => ({
      ...auditLog,
      actor: auditLog.actorId ? (userById.get(auditLog.actorId) ?? null) : null,
      targetUser: auditLog.targetUserId
        ? (userById.get(auditLog.targetUserId) ?? null)
        : null,
    }));
  }

  private async buildFilter(
    query: AuditLogQueryDto,
  ): Promise<Prisma.AuditLogWhereInput | undefined> {
    const where: Prisma.AuditLogWhereInput = {};

    if (query.actorId) where.actorId = query.actorId;
    if (query.targetUserId) where.targetUserId = query.targetUserId;

    const createdAtFilter = buildDateRangeFilter({
      start: query.startCreatedAt,
      end: query.endCreatedAt,
    });
    if (createdAtFilter) where.createdAt = createdAtFilter;

    // Exact `action` takes precedence over `search`: an operator passing
    // `?action=` already knows the exact key they want, so widening it back out
    // would be actively unhelpful.
    //
    // Free-text `search` matches THREE signals at once, OR'd together:
    //   1. `action` substring, case-insensitive.
    //   2. Either party's email — resolved to a user-id list and OR'd in via
    //      `actorId`/`targetUserId`. Answers "every entry involving foo@bar.com".
    //   3. The `metadata` envelope as text — resolved to an audit-id list by a
    //      raw pre-query that uses the pg_trgm GIN index. Answers "every entry
    //      referencing this order id" without a per-resource query surface.
    //
    // Name search (firstName/lastName) is deliberately omitted: operators
    // almost always have the email, names are ambiguous, and a GDPR-erased user
    // has had them nulled anyway.
    if (query.action) {
      where.action = query.action;
    } else if (query.search) {
      const term = query.search;
      const [matchingUserIds, matchingAuditLogIds] = await Promise.all([
        this.findUserIdsMatchingEmail(term),
        this.findAuditLogIdsMatchingMetadata(term),
      ]);
      const orClauses: Prisma.AuditLogWhereInput[] = [
        { action: { contains: term, mode: 'insensitive' } },
      ];
      if (matchingUserIds.length > 0) {
        orClauses.push({ actorId: { in: matchingUserIds } });
        orClauses.push({ targetUserId: { in: matchingUserIds } });
      }
      if (matchingAuditLogIds.length > 0) {
        orClauses.push({ id: { in: matchingAuditLogIds } });
      }
      where.OR = orClauses;
    }

    return Object.keys(where).length > 0 ? where : undefined;
  }

  // Resolves a free-text term to the user ids whose email substring-matches it.
  // Raw `this.prisma.user` (not `prisma.scoped`) so entries for soft-deleted
  // users still surface — searching by a closed account's email is a legitimate
  // forensic pattern, arguably the most common one.
  private async findUserIdsMatchingEmail(term: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { email: { contains: term, mode: 'insensitive' } },
      select: { id: true },
    });
    return users.map((user) => user.id);
  }

  // Raw SQL pre-query finding audit-log ids whose serialized metadata contains
  // `term`, case-insensitively.
  //
  // This is what the pg_trgm GIN index on `(metadata::text)` in the init
  // migration is FOR. Prisma's own `{ metadata: { string_contains } }` is a
  // JSON-path filter — it tests whether the JSON value at a path is a string
  // containing the term, so against an object-valued `metadata` column it
  // matches nothing at all and never touches the index.
  //
  // Pre-resolving to a small id set and OR-ing it into the type-safe builder,
  // rather than hand-writing the whole query in SQL, keeps the rest of the
  // `where` (date range, actor/target filters, sort, pagination) type-checked
  // end to end. The trigram lookup is fast enough that the extra round trip is
  // invisible.
  //
  // The `$queryRaw` tag parameterizes `pattern`, so the operator-supplied term
  // is never concatenated into SQL.
  private async findAuditLogIdsMatchingMetadata(
    term: string,
  ): Promise<string[]> {
    const pattern = `%${term}%`;
    const auditLogs = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM audit_logs WHERE metadata::text ILIKE ${pattern}
    `;
    return auditLogs.map((auditLog) => auditLog.id);
  }
}
