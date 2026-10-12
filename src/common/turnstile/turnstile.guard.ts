import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../errors/errors';
import { clientPlatformOf } from '../util/client-platform.util';
import { TurnstileService } from './turnstile.service';
import type { TurnstileWidget } from './turnstile.service';

export const TURNSTILE_TOKEN_HEADER = 'X-Turnstile-Token';

/**
 * The Turnstile bot check, applied per route with `@RequireTurnstile()`.
 *
 * Reads the token from the `X-Turnstile-Token` header — not the body, so DTOs
 * stay business-only and the check runs before validation. Method-level guards
 * run after the global ones, so the throttler has already counted the request
 * and nothing else has happened: no code minted, no send budget reserved, no
 * password checked.
 *
 * The widget is chosen by the `Origin` header (`clientPlatformOf`): present →
 * `web`, absent → `mobile`. Origin is a SELECTOR, never a bypass. Stripping
 * it only selects the app's widget, whose secret still has to verify the
 * token; never add a path where a missing Origin skips verification. A server-rendered website
 * forwards the browser's Origin on its server-side calls
 * (docs/deployment/README.md, "Client topologies").
 *
 * The presence check is unconditional: even while TurnstileService is skipping
 * verification during a Cloudflare outage, a request with no token is refused.
 * The outage skips VERIFYING a token, never REQUIRING one.
 *
 * Passes everything only when the check is off — both secrets unset, which
 * env validation allows in development and test only.
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  constructor(private readonly turnstileService: TurnstileService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.turnstileService.isEnabled()) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = request.header(TURNSTILE_TOKEN_HEADER)?.trim();
    if (!token) {
      throw Errors.turnstileTokenMissing();
    }

    const widget: TurnstileWidget = clientPlatformOf(request);
    // `request.ip` honours TRUST_PROXY, so behind the edge proxy it is the
    // caller's address.
    await this.turnstileService.verify(token, widget, request.ip);
    return true;
  }
}
