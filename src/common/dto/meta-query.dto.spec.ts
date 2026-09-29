import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MAX_PER_PAGE, MetaQueryDto } from './meta-query.dto';

// Mirrors the global ValidationPipe: query strings arrive as strings and are
// converted implicitly.
async function parse(
  query: Record<string, string>,
): Promise<{ dto: MetaQueryDto; errorCount: number }> {
  const dto = plainToInstance(MetaQueryDto, query, {
    enableImplicitConversion: true,
  });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errorCount: errors.length };
}

describe('MetaQueryDto perPage', () => {
  it('clamps values above the maximum instead of rejecting them', async () => {
    const { dto, errorCount } = await parse({ perPage: '500' });
    expect(errorCount).toBe(0);
    expect(dto.perPage).toBe(MAX_PER_PAGE);
  });

  it('keeps values within range', async () => {
    const { dto, errorCount } = await parse({ perPage: '25' });
    expect(errorCount).toBe(0);
    expect(dto.perPage).toBe(25);
  });

  it('defaults to 20', async () => {
    const { dto } = await parse({});
    expect(dto.perPage).toBe(20);
  });

  it.each(['0', '-5', 'abc', '2.5'])('rejects %s', async (perPage) => {
    const { errorCount } = await parse({ perPage });
    expect(errorCount).toBe(1);
  });
});
