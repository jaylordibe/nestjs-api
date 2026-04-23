import 'dotenv/config';
import { expand } from 'dotenv-expand';
import * as dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

expand(dotenv.config({ override: false }));

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
