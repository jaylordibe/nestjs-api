import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { MetaQueryDto } from '../../../common/dto/meta-query.dto';

export class AuditLogQueryDto extends MetaQueryDto {
  // Exact-match on the dotted action name (e.g. `user.role_assigned`).
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  // Calendar dates, not timestamps — `@IsDateString`, per CLAUDE.md.
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}
