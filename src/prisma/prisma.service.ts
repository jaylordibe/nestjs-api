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
    const adapter = new PrismaPg({
      connectionString: configService.getOrThrow<string>('database.url'),
    });
    super({ adapter });
    this.scoped = buildScopedClient(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
