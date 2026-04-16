import 'dotenv/config';
import { expand } from 'dotenv-expand';
import * as dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

expand(dotenv.config({ override: false }));

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
