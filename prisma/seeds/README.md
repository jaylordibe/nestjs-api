# prisma/seeds

Static seed data as JSON (or CSV/YAML) — the input files that
`prisma/seed.ts` reads from when running `yarn prisma:seed`.

Why a separate dir from `seed.ts`:

- Keeps the seed script focused on *how* (read file, upsert rows) and the
  data focused on *what* (rows themselves), so designers/non-engineers can
  edit the data without touching TypeScript.
- Multiple seed files are easy: one JSON per resource (`roles.json`,
  `tour-categories.json`, …) and one upsert pass per file in `seed.ts`.

Convention: filenames are kebab-case singular of the resource
(`tour-category.json`, not `tour-categories.json`). Seed inserts are
upserts keyed on a stable natural id (slug / code), so re-running the
seeder is idempotent.

## Exception: roles and permissions are NOT seeded from JSON

The authorization catalog lives in TypeScript, at
`src/common/authorization/permission-catalog.ts`, and is projected onto the
database by `prisma/rbac-seeder.ts`.

It has to. `@RequirePermission(action, subject)` is typed against that file,
so a typo'd permission is a **compile error** rather than a runtime 403, and
`AbilityFactory` derives its CASL rules from the same constants. Moving the
catalog to JSON would make both guarantees unenforceable — the compiler cannot
check a string in a `.json` file.

The database is a projection of the catalog, never the reverse.
`PermissionCatalogIntegrityService` refuses to boot the app when the two
disagree, and `yarn rbac:check` asserts the same in CI.
