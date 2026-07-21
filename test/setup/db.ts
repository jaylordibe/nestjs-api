import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../src/common/redis/redis.service';
import { PrismaService } from '../../src/prisma/prisma.service';

// Wipes this worker's Redis keyspace alongside its Postgres tables. Without
// it, anything the app parks in Redis (the JWT logout blocklist, caches, any
// cooldown a feature adds later) outlives both the truncate and the run, so
// specs pass on a clean box and fail on a re-run.
//
// Refuses to run unless REDIS_URL names a non-zero logical database. Dev and
// test run separate containers but the guard is kept as a floor: `flushdb` on
// index 0 would wipe a developer's local keys if this ever got repointed, and
// a destructive default is not worth the convenience — a misconfigured env
// fails loudly instead. `load-env.ts` assigns index N to worker N, so this
// also keeps parallel workers from flushing each other.
async function flushTestRedisKeyspace(app: INestApplication): Promise<void> {
  const redisUrl = app.get(ConfigService).getOrThrow<string>('redis.url');
  const databaseIndex = new URL(redisUrl).pathname.replace('/', '');
  if (!databaseIndex || databaseIndex === '0') {
    throw new Error(
      `Refusing to flush Redis: REDIS_URL must point the e2e suite at its own ` +
        `logical DB (e.g. …:6380/1), got "${redisUrl}". Flushing DB 0 would ` +
        `wipe local dev state.`,
    );
  }
  await app.get(RedisService).client.flushdb();
}

export async function truncateAll(app: INestApplication): Promise<void> {
  await flushTestRedisKeyspace(app);
  const prisma = app.get(PrismaService);
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const tableList = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );
}
