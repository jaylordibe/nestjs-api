# prisma/scripts

One-off ts-node admin scripts: data backfills, one-time imports, ad-hoc
queries that aren't part of the migration history.

Run via:

```sh
npx ts-node --transpile-only prisma/scripts/<name>.ts
```

Conventions:

- Each script reads `.env` and constructs its own `PrismaClient` (no Nest DI).
- Idempotent where possible — script may be re-run after a partial failure.
- Log row counts on completion so the operator has a paper trail.
- Delete the script (or move it elsewhere) once it's no longer needed —
  this dir is for live one-offs, not historical archive.
