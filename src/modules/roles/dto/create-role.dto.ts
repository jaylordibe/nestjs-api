import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RoleScope } from '../../../common/enums/role-scope.enum';

export class CreateRoleDto {
  // lowercase_snake, matching the seeded roles.
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message: 'name must be lowercase_snake_case',
  })
  name!: string;

  @IsEnum(RoleScope)
  scope!: RoleScope;

  // Bounded below 100 so a custom role can never outrank the built-in
  // PLATFORM_ADMIN / BUSINESS_OWNER and slip past the escalation guard.
  @IsInt()
  @Min(1)
  @Max(99)
  rank!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  // Every permission must share this role's scope — asserted in the service.
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  permissionIds!: string[];
}
