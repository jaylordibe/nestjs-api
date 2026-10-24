import { expand } from 'dotenv-expand';
import * as dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';
import { isEnvFileIgnored } from './src/config/configuration';

// The same rule as ConfigModule: under test only `.env.test` (already loaded
// by test/setup) applies, so the e2e `prisma migrate deploy` never picks up a
// developer's `.env` and the real keys in it.
if (!isEnvFileIgnored()) {
  expand(dotenv.config({ override: false }));
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Seed command is declared here (Prisma 7+) rather than in
    // package.json. `yarn prisma:seed` resolves to `prisma db seed`,
    // which executes this command.
    seed: 'ts-node --transpile-only prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
