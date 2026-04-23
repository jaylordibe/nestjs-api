import { Prisma } from '@prisma/client';

// Models that carry a `deletedAt` column. Every read on these models is
// filtered to `deletedAt: null` by the `scoped` Prisma client below, so
// soft-deleted rows are invisible by default. Admin/forensic paths that
// need to see soft-deleted rows must use the raw `PrismaService` (the
// class itself, no `.scoped`). Add a model to this set when you give it
// its own `deletedAt` column.
const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set(['User']);

type SoftDeletable = { deletedAt: Date | null };

function injectFilter(args: { where?: Record<string, unknown> }) {
  // Put deletedAt: null first so an explicit caller-supplied deletedAt (e.g.
  // `{ deletedAt: { not: null } }` for "show me deleted rows") overrides it.
  args.where = { deletedAt: null, ...(args.where ?? {}) };
  return args;
}

export const softDeleteExtension = Prisma.defineExtension({
  name: 'soft-delete',
  query: {
    $allModels: {
      async findFirst({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectFilter(args);
        return query(args);
      },
      async findFirstOrThrow({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectFilter(args);
        return query(args);
      },
      async findMany({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectFilter(args);
        return query(args);
      },
      async count({ model, args, query }) {
        if (SOFT_DELETE_MODELS.has(model)) injectFilter(args);
        return query(args);
      },
      // `findUnique` only accepts unique fields in `where`, so we can't
      // inject `deletedAt: null` into the query. Fetch then nullify if the
      // returned row is soft-deleted — semantically identical for callers.
      async findUnique({ model, args, query }) {
        const result = await query(args);
        if (!SOFT_DELETE_MODELS.has(model)) return result;
        const typed = result as SoftDeletable | null;
        return typed && typed.deletedAt !== null ? null : result;
      },
      async findUniqueOrThrow({ model, args, query }) {
        const result = await query(args);
        if (!SOFT_DELETE_MODELS.has(model)) return result;
        const typed = result as SoftDeletable | null;
        if (typed && typed.deletedAt !== null) {
          throw new Prisma.PrismaClientKnownRequestError(
            'No record found (soft-deleted)',
            { code: 'P2025', clientVersion: '7' },
          );
        }
        return result;
      },
      // Writes (create/update/delete) pass through unchanged. Admin restore
      // flows (update a deleted row to clear deletedAt) work naturally; hard-
      // delete of a soft-deleted row for retention cleanup also works.
    },
  },
});
