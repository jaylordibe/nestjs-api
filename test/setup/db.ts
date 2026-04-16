import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';

export async function truncateAll(app: INestApplication): Promise<void> {
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
