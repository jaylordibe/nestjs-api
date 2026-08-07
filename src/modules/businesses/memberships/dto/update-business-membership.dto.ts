import { IsOptional, IsString, MaxLength } from 'class-validator';

// `notes` is the ONLY field this endpoint mutates.
//
// Role changes go through `PATCH …/role` (`assignRole`), suspension through
// `POST …/suspend` (`suspend`), and ending a membership through `DELETE`
// (`delete`). Splitting them is the whole reason `manage` is never granted on
// this subject: folding a role change into a general `update` would let any
// caller holding `update BusinessMembership` escalate privilege through a
// field they were only meant to annotate.
export class UpdateBusinessMembershipDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
