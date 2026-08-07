import { IsEnum, IsOptional } from 'class-validator';
import { MetaQueryDto } from '../../../../common/dto/meta-query.dto';
import { BusinessMembershipStatus } from '../../../../common/enums/business-membership-status.enum';

export class BusinessMembershipQueryDto extends MetaQueryDto {
  // Absent means ACTIVE only — the roster question people actually ask is "who
  // works here", not "who has ever been associated with this business". Ended
  // and suspended memberships are retained forever, so an unfiltered default
  // would grow without bound and quietly turn a roster page into an archive.
  // Pass an explicit status to reach the history.
  @IsOptional()
  @IsEnum(BusinessMembershipStatus)
  status?: BusinessMembershipStatus;
}
