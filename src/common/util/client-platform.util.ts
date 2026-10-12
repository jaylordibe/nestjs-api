import type { Request } from 'express';
import { AppPlatform } from '../enums/app-platform.enum';
import type { ClientPlatform } from '../constants/client-platforms';

/**
 * Which client sent a request: `Origin` present → the website, absent → the
 * app. A browser always sends `Origin` on a POST and cannot forge it; the
 * native app sends none; the server-rendered website forwards the browser's
 * (docs/deployment/README.md, "Client topologies").
 *
 * Any other caller chooses the answer by setting or leaving out the header.
 * So it is good for picking the Turnstile widget, whose secret still has to
 * verify the token — and must never decide money,
 * entitlement, ranking or permission.
 */
export const clientPlatformOf = (request: Request): ClientPlatform =>
  request.header('origin') ? AppPlatform.WEB : AppPlatform.MOBILE;
