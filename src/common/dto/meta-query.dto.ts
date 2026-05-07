import { BadRequestException } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

// Generic query shape for every list endpoint (findAll + findPaginated).
// All fields optional — services pick the subset they care about:
// findAll typically honors search/sortBy/sortOrder; findPaginated honors
// all five. Add new cross-cutting query params here as they emerge
// (cursor, includeDeleted, dateFrom, etc.) so every list endpoint picks
// them up in lockstep.
//
// `page` and `perPage` carry inline defaults so services can read them
// directly (`query.page` / `query.perPage`) without `?? 1` / `?? 20`
// noise on every list method. `sortBy`/`sortOrder` stay optional on
// purpose: services need to distinguish "user requested a sort" from
// "fall back to the per-endpoint compound default", which a default
// value would erase.
//
// `@ApiPropertyOptional` on `page` / `perPage` is load-bearing: the
// fields are TS-typed as plain `number` (no `?` marker) so service
// code can read `query.page` without the type system thinking it might
// be undefined, but the Swagger plugin uses the TS optional marker as
// the source of truth for the schema's `required` flag. Without the
// explicit decorator, Swagger would advertise these as required even
// though `@IsOptional()` lets requests omit them.
export class MetaQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  perPage: number = 20;

  // Free-text search term. The set of fields it actually searches is
  // resource-specific and lives in the service. Trimmed; whitespace-only
  // is treated as no filter so a stray `?search=  ` doesn't return zero
  // rows.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  // Column name to sort by. Validated at the service layer against a
  // per-resource allowlist (via `buildOrderBy`) — relation paths and
  // sensitive columns must never reach Prisma's orderBy. Lax @IsString
  // here on purpose: the strict check needs to know the resource, which
  // the DTO doesn't.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sortBy?: string;

  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}

// Resolves `query.sortBy`/`query.sortOrder` into a Prisma `orderBy`,
// throwing 400 if `sortBy` is set but not in `allowedColumns`. Bypassing
// this would let a client sort by relation paths or sensitive columns.
// `defaultColumn` is used when `sortBy` is omitted; `defaultOrder`
// defaults to 'desc' (typical "newest first" for createdAt) — pass 'asc'
// when the natural default differs (e.g. ordering by name).
//
//   buildOrderBy(query, ['name', 'createdAt', 'updatedAt'], 'createdAt')
//   → { createdAt: 'desc' }   when query has no sortBy
//   → { name: 'asc' }         when query is { sortBy: 'name', sortOrder: 'asc' }
//   → throws BadRequest       when query is { sortBy: 'password' }
export function buildOrderBy<TColumn extends string>(
  query: MetaQueryDto,
  allowedColumns: readonly TColumn[],
  defaultColumn: TColumn,
  defaultOrder: SortOrder = SortOrder.DESC,
): { [K in TColumn]?: SortOrder } {
  const requested = query.sortBy as TColumn | undefined;
  if (requested !== undefined && !allowedColumns.includes(requested)) {
    throw new BadRequestException(
      `sortBy must be one of: ${allowedColumns.join(', ')}`,
    );
  }
  const column = requested ?? defaultColumn;
  const order = query.sortOrder ?? defaultOrder;
  return { [column]: order } as { [K in TColumn]?: SortOrder };
}
