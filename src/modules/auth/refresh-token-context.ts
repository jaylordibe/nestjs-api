import type { Request } from 'express';
import type { RefreshTokenContext } from './refresh-token.service';

// Device provenance recorded against an issued refresh token. `request.ip`
// honours `trust proxy` (configure-http-app.ts). Best-effort: a missing header
// never fails a sign-in.
export function readRefreshTokenContext(request: Request): RefreshTokenContext {
  return {
    userAgent: request.get('user-agent') ?? null,
    ipAddress: request.ip ?? null,
  };
}
