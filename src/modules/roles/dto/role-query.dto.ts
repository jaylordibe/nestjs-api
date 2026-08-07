import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { MetaQueryDto } from '../../../common/dto/meta-query.dto';
import { RoleScope } from '../../../common/enums/role-scope.enum';

export class RoleQueryDto extends MetaQueryDto {
  @IsOptional()
  @IsEnum(RoleScope)
  scope?: RoleScope;

  /**
   * Narrows the list to roles the caller may actually assign inside this
   * business — business-scoped, and at or below their own rank there.
   *
   * This exists because an assignment UI that lists every role invites a
   * request that is guaranteed to 403, and worse, tells a curious admin exactly
   * which roles sit above them. The rank ceiling is enforced on write no matter
   * what, so this is ergonomics rather than a control; but a picker that only
   * offers reachable options is the difference between a boundary users
   * understand and one they probe.
   */
  @IsOptional()
  @IsUUID()
  assignableIn?: string;
}
