import { IsString, MaxLength, MinLength } from 'class-validator';

// The token is the credential, so it is carried in a POST body rather than a
// query string: query strings land in access logs, browser history, and
// `Referer` headers on any outbound link from the landing page.
//
// Bounded rather than free-form. The token this API mints is a fixed 43-char
// base64url string; accepting an unbounded one would let an unauthenticated
// caller push arbitrary megabytes through a SHA-256 on a public-facing path.
export class AcceptBusinessInvitationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(200)
  token!: string;
}
