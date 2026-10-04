import { IsEnum, IsOptional } from 'class-validator';
import { MetaQueryDto } from '../../../../common/dto/meta-query.dto';
import { WorkspaceMembershipStatus } from '../../../../common/enums/workspace-membership-status.enum';

export class WorkspaceMembershipQueryDto extends MetaQueryDto {
  // Absent means ACTIVE only — the roster question people actually ask is "who
  // works here", not "who has ever been associated with this workspace". Ended
  // and suspended memberships are retained forever, so an unfiltered default
  // would grow without bound and quietly turn a roster page into an archive.
  // Pass an explicit status to reach the history.
  @IsOptional()
  @IsEnum(WorkspaceMembershipStatus)
  status?: WorkspaceMembershipStatus;
}
