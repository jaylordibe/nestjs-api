import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import * as Handlebars from 'handlebars';
import { TurnstileService } from '../../common/turnstile/turnstile.service';
import { deriveOAuthServerKeys } from '../../common/util/oauth-keys.util';

export type OAuthPageView = 'login' | 'consent' | 'message';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * Renders the MCP OAuth sign-in and consent pages — the only HTML the API
 * serves — with the headers a credential page needs:
 *
 * - never framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), so no
 *   other site can overlay it to harvest a password or a click;
 * - a per-response CSP nonce for its one style block (and the Turnstile
 *   script), and nothing else may load;
 * - `form-action` allowing this origin plus the client's registered redirect
 *   origin: the browser applies `form-action` to the redirect that follows a
 *   form post, and the consent post ends at the client.
 *
 * Handlebars `{{ }}` escapes, so a client name or redirect URI chosen by a
 * self-registered client renders as text, never markup.
 */
@Injectable()
export class OAuthPagesService implements OnModuleInit {
  private readonly appName: string;
  private readonly turnstileSiteKey: string | undefined;
  private readonly formTokenKey: Buffer;
  private layout!: HandlebarsTemplateDelegate;
  private readonly views = new Map<OAuthPageView, HandlebarsTemplateDelegate>();

  private readonly logger = new Logger(OAuthPagesService.name);

  constructor(
    configService: ConfigService,
    private readonly turnstileService: TurnstileService,
  ) {
    this.appName = configService.getOrThrow<string>('serviceName');
    this.turnstileSiteKey = configService.get<string>('turnstile.webSiteKey');
    this.formTokenKey = deriveOAuthServerKeys(
      configService.getOrThrow<string>('jwt.secret'),
    ).formTokenKey;
  }

  /**
   * Whether the sign-in page can be offered: with the bot check on, it needs
   * the website widget's site key to render a widget the sign-in post can
   * pass. Without it the page refuses (rather than the whole app failing to
   * boot), and the boot log says why.
   */
  get isSignInAvailable(): boolean {
    return (
      !this.turnstileService.isEnabled() || this.turnstileSiteKey !== undefined
    );
  }

  onModuleInit(): void {
    if (!this.isSignInAvailable) {
      this.logger.error(
        'MCP OAuth sign-in is unavailable: the Turnstile bot check is on but TURNSTILE_WEB_SITE_KEY is not set.',
      );
    }
    const directory = path.join(__dirname, 'views');
    const compile = (name: string) =>
      Handlebars.compile(
        fs.readFileSync(path.join(directory, `${name}.hbs`), 'utf8'),
        { strict: false },
      );
    this.layout = compile('layout');
    for (const view of ['login', 'consent', 'message'] as const) {
      this.views.set(view, compile(view));
    }
  }

  render(
    response: Response,
    view: OAuthPageView,
    data: { title: string } & Record<string, unknown>,
    options: { status?: number; redirectUri?: string } = {},
  ): void {
    const nonce = randomBytes(16).toString('base64');
    const turnstileSiteKey =
      view === 'login' ? this.turnstileSiteKey : undefined;
    const context = { ...data, appName: this.appName, nonce, turnstileSiteKey };
    const content = this.views.get(view)!(context);
    const html = this.layout({ ...context, content });

    const formActions = ["'self'"];
    if (options.redirectUri && URL.canParse(options.redirectUri)) {
      formActions.push(new URL(options.redirectUri).origin);
    }
    const directives = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      turnstileSiteKey
        ? `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`
        : "script-src 'none'",
      turnstileSiteKey ? `frame-src ${TURNSTILE_ORIGIN}` : "frame-src 'none'",
      turnstileSiteKey
        ? `connect-src ${TURNSTILE_ORIGIN}`
        : "connect-src 'none'",
      "img-src 'self'",
      `form-action ${formActions.join(' ')}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ];
    response
      .status(options.status ?? 200)
      .setHeader('Content-Security-Policy', directives.join('; '))
      .setHeader('X-Frame-Options', 'DENY')
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Referrer-Policy', 'no-referrer')
      .type('html')
      .send(html);
  }

  /**
   * The anti-forgery token for one sign-in attempt's forms: an HMAC of its
   * interaction id. A forged cross-site post cannot carry it — it never sees
   * the page — and the provider's SameSite=Lax interaction cookie, which binds
   * the attempt to the browser that started it, is not sent with one either.
   */
  formToken(interactionUid: string): string {
    return createHmac('sha256', this.formTokenKey)
      .update(`mcp-oauth-form:${interactionUid}`)
      .digest('base64url');
  }

  isValidFormToken(interactionUid: string, presented: unknown): boolean {
    if (typeof presented !== 'string') return false;
    const expected = Buffer.from(this.formToken(interactionUid));
    const actual = Buffer.from(presented);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}
