import { Prisma } from '@prisma/client';

// Models that carry a `deletedAt` column.
//
// ⚠️ SCOPE OF THIS FILTER — read before relying on it.
//
// It rewrites TOP-LEVEL reads only (`findFirst`, `findMany`, `findUnique`,
// `count`, …). Prisma client extensions cannot intercept NESTED reads, so a
// soft-deleted row is still reachable through a relation:
//
//     prisma.scoped.business.findFirst({
//       include: { members: { include: { user: true } } },   // ← soft-deleted
//     })                                                     //   users appear
//
// Whenever you `include` a soft-delete model, filter it EXPLICITLY:
//
//   - to-many relation → `include: { members: { where: { user: { deletedAt: null } } } }`
//   - to-one relation  → Prisma has no `where` on a to-one include, so filter the
//     PARENT rows instead: `where: { user: { deletedAt: null } }`
//
// Soft delete is therefore a convenience for the common path, never a security
// boundary. Authorization boundaries live in `AbilityScopedQueryService`, which
// filters in the query itself.
//
// Admin/forensic paths that need to SEE soft-deleted rows use the raw
// `PrismaService` (the class itself, no `.scoped`). Add a model to this set when
// you give it its own `deletedAt` column.
const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set(['User', 'Business']);

// Put `deletedAt: null` FIRST so an explicit caller-supplied `deletedAt` (e.g.
// `{ deletedAt: { not: null } }` for "show me deleted rows") overrides it.
function injectLiveOnlyFilter(args: { where?: Record<string, unknown> }) {
  args.where = { deletedAt: null, ...(args.where ?? {}) };
  return args;
}

export const softDeleteExtension = Prisma.defineExtension({
  name: 'soft-delete',
  query: {
    $allModels: {
      async findFirst({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectLiveOnlyFilter(args);
        return query(args);
      },
      async findFirstOrThrow({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectLiveOnlyFilter(args);
        return query(args);
      },
      async findMany({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectLiveOnlyFilter(args);
        return query(args);
      },
      async count({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectLiveOnlyFilter(args);
        return query(args);
      },

      // `findUnique` used to accept ONLY unique selectors in `where`, which is
      // why soft-delete extensions historically fetched the row and nullified
      // it afterwards. That hack had a nasty failure mode: a caller passing
      // `select: { id: true }` got back a row whose `deletedAt` was `undefined`,
      // and `undefined !== null` silently nullified a perfectly live record.
      //
      // Prisma's `extendedWhereUnique` (GA since v5, verified on v7) lets
      // `where` carry extra non-unique filters alongside the unique selector,
      // so we now filter in the QUERY, exactly like `findFirst`. Same code path,
      // no post-processing, no projection surprises.
      //
      // `findUniqueOrThrow` raises P2025 for a soft-deleted row, which the
      // global filter maps to 404 RESOURCE_NOT_FOUND — the behaviour callers
      // already expect for a missing row.
      async findUnique({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectLiveOnlyFilter(args);
        return query(args);
      },
      async findUniqueOrThrow({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectLiveOnlyFilter(args);
        return query(args);
      },

      // Writes (create/update/delete) pass through unchanged. Admin restore
      // flows (update a deleted row to clear deletedAt) work naturally; hard-
      // delete of a soft-deleted row for retention cleanup also works.
    },
  },
});
