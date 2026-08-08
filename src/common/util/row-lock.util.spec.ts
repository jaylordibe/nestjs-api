import type { Prisma } from '@prisma/client';
import {
  lockBusinessRow,
  lockBusinessRows,
  lockRefreshTokenFamily,
  lockUserRow,
  lockUserRows,
} from './row-lock.util';

/**
 * The ordering guarantees are the whole reason this module exists, and they are
 * invisible at runtime until two transactions deadlock in production. Asserting
 * them here means a future edit that "simplifies" the loop into a single
 * `IN (…) ORDER BY id` statement fails a test instead of shipping.
 */
interface CapturedStatement {
  sql: string;
  values: unknown[];
}

function createRecordingTransaction(): {
  transaction: Prisma.TransactionClient;
  statements: CapturedStatement[];
} {
  const statements: CapturedStatement[] = [];
  const transaction = {
    $queryRaw: (fragments: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: fragments.join('?').trim(), values });
      return Promise.resolve([]);
    },
  } as unknown as Prisma.TransactionClient;
  return { transaction, statements };
}

describe('row-lock util', () => {
  describe('lockUserRow', () => {
    it('takes a row-level exclusive lock on users, parameterised', async () => {
      const { transaction, statements } = createRecordingTransaction();

      await lockUserRow(transaction, 'a5f0c1d2-0000-4000-8000-000000000001');

      expect(statements).toHaveLength(1);
      expect(statements[0].sql).toBe(
        'SELECT id FROM users WHERE id = ?::uuid FOR UPDATE',
      );
      // Interpolated as a bound parameter, never concatenated into the SQL.
      expect(statements[0].values).toEqual([
        'a5f0c1d2-0000-4000-8000-000000000001',
      ]);
    });
  });

  describe('lockBusinessRow', () => {
    it('takes a row-level exclusive lock on businesses', async () => {
      const { transaction, statements } = createRecordingTransaction();

      await lockBusinessRow(
        transaction,
        'b5f0c1d2-0000-4000-8000-000000000002',
      );

      expect(statements[0].sql).toBe(
        'SELECT id FROM businesses WHERE id = ?::uuid FOR UPDATE',
      );
    });
  });

  describe('lockRefreshTokenFamily', () => {
    // The whole family, not one token: the invariant protected is "a revoked
    // family gains no new children", which spans rows.
    it('locks every row in the family', async () => {
      const { transaction, statements } = createRecordingTransaction();

      await lockRefreshTokenFamily(
        transaction,
        'c5f0c1d2-0000-4000-8000-000000000003',
      );

      expect(statements[0].sql).toBe(
        'SELECT id FROM refresh_tokens WHERE family_id = ?::uuid FOR UPDATE',
      );
    });
  });

  describe.each([
    ['lockUserRows', lockUserRows],
    ['lockBusinessRows', lockBusinessRows],
  ] as const)('%s', (_name, lockRows) => {
    it('locks ascending, one statement at a time', async () => {
      const { transaction, statements } = createRecordingTransaction();

      await lockRows(transaction, ['ccc', 'aaa', 'bbb']);

      // One statement per id — NOT a single `IN (…) ORDER BY id`, whose locks
      // are taken during the scan and therefore ignore the sort.
      expect(statements).toHaveLength(3);
      expect(statements.map((statement) => statement.values[0])).toEqual([
        'aaa',
        'bbb',
        'ccc',
      ]);
    });

    it('collapses duplicates so the order stays a total order', async () => {
      const { transaction, statements } = createRecordingTransaction();

      await lockRows(transaction, ['bbb', 'aaa', 'bbb']);

      expect(statements.map((statement) => statement.values[0])).toEqual([
        'aaa',
        'bbb',
      ]);
    });

    it('issues nothing for an empty list', async () => {
      const { transaction, statements } = createRecordingTransaction();

      await lockRows(transaction, []);

      expect(statements).toEqual([]);
    });
  });
});
