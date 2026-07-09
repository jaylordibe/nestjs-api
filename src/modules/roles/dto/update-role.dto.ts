import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateRoleDto } from './create-role.dto';

// `scope` is immutable: changing it would silently move every assignment of
// this role across the platform/business boundary that the database
// constraints exist to defend.
export class UpdateRoleDto extends PartialType(
  OmitType(CreateRoleDto, ['scope'] as const),
) {}
