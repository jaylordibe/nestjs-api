import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsUtcIsoString } from '../../../common/decorators/is-utc-iso-string.decorator';
import { MetaQueryDto } from '../../../common/dto/meta-query.dto';

// Filters for `GET /api/audit-logs`.
//
// `search` is the broad one — it matches the action name, the metadata
// envelope, and the email of either party (see the service for exactly what and
// why). The remaining fields are exact-match narrowing for when search is too
// blunt: most operators paste a UUID or pick a range rather than scroll.
export class AuditLogQueryDto extends MetaQueryDto {
  // Exact-match on the dotted action name (e.g. `user.role_assigned`). Use
  // `search` for substring matching across actions.
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

  // Range on `createdAt`, inclusive on both ends.
  //
  // Named for the column they filter rather than `fromDate`/`toDate`: an audit
  // row has exactly one timestamp today, but the moment a resource grows a
  // second date the generic name is ambiguous at the call site and in the docs.
  //
  // Full UTC instants rather than calendar dates, because `createdAt` is a
  // moment-in-time column and the forensic question is usually "what happened
  // between 14:00 and 15:00 during the incident" — which a day-granular filter
  // cannot express. Per CLAUDE.md a moment-in-time input is `@IsUtcIsoString`
  // and a calendar-date-only one is `@IsDateString`; this is the former.
  @IsOptional()
  @IsUtcIsoString()
  startCreatedAt?: string;

  @IsOptional()
  @IsUtcIsoString()
  endCreatedAt?: string;
}
