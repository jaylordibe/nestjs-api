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
