import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { softDeleteExtension } from './prisma-soft-delete.extension';

// Derived so TypeScript infers the exact extended-client type that
// $extends returns — declaring it inline on the property doesn't work
// because `typeof this.$extends<...>` isn't valid TS syntax.
function buildScopedClient(client: PrismaClient) {
  return client.$extends(softDeleteExtension);
}

// Two client "views" on the same underlying connection pool:
//
//   - PrismaService itself (this / `this.prisma.user.*`) is RAW. It sees
//     every row, including soft-deleted ones. Use it in admin/forensic/
//     recovery/retention code paths that need visibility over deleted rows.
//
//   - `this.prisma.scoped` is the FILTERED client. Every read on a soft-
//     delete model auto-injects `deletedAt: null`, so soft-deleted rows
//     are invisible. Use it in every user-facing code path.
//
// Both share the same connection — the extension wraps, not duplicates.
// Writes (create/update/delete) pass through on both; the filter only
// applies to reads.
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  readonly scoped: ReturnType<typeof buildScopedClient>;

  constructor(configService: ConfigService) {
    // The pg pool is sized EXPLICITLY, because this process is one of many.
    // The API scales horizontally, so the database sees
    // `max API instances × DATABASE_POOL_MAX` + `worker instances × the same` +
    // whatever the migration job holds. That product must stay under the
    // server's own connection limit (`max_connections`, minus whatever reserve
    // it keeps for superusers), and it cannot be reasoned about at all while
    // the per-process number is an implicit library default.
    //
    // A logger is not attached here: `PrismaService` extends `PrismaClient`, so
    // `this` is unavailable until after `super()`, and the pool callbacks below
    // are installed as part of the constructor argument. They use a plain
    // `Logger` instance instead.
    const poolLogger = new Logger(PrismaService.name);
    const adapter = new PrismaPg(
      {
        connectionString: configService.getOrThrow<string>('database.url'),
        max: configService.getOrThrow<number>('database.poolMax'),
        connectionTimeoutMillis: configService.getOrThrow<number>(
          'database.connectionTimeoutMs',
        ),
        idleTimeoutMillis: configService.getOrThrow<number>(
          'database.idleTimeoutMs',
        ),
      },
      {
        // The adapter already attaches its own `error` listener to every pooled
        // client, so the process is not at risk of Node's throw-on-unhandled-
        // `error` behaviour. These callbacks are what makes such an event
        // OBSERVABLE instead of silently swallowed: an idle connection dropped
        // by a database failover, a maintenance restart or a proxy timeout — so without these the
        // failure mode is not a logged warning but a dead process.
        onPoolError: (error) => {
          poolLogger.warn(`Postgres pool error: ${error.message}`);
        },
        onConnectionError: (error) => {
          poolLogger.warn(`Postgres connection error: ${error.message}`);
        },
      },
    );
    super({ adapter });
    this.scoped = buildScopedClient(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  // `$disconnect()` disposes the driver adapter, which ends the pg pool this
  // service created — so every pooled connection is returned to Postgres rather
  // than left for the server to time out. Reached through
  // `app.enableShutdownHooks()` (main.ts) and through the explicit
  // `context.close()` in the worker entrypoint.
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected, Postgres pool closed');
  }
}
