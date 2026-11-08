import {
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { InteractionResults } from 'oidc-provider';
import { Public } from '../../common/decorators/public.decorator';
import { RequireTurnstile } from '../../common/decorators/require-turnstile.decorator';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { ThrottleSignIn } from '../../common/decorators/throttle-sign-in.decorator';
import { AuthService } from '../auth/auth.service';
import { MCP_OAUTH_PATHS, MCP_OAUTH_THROTTLE } from './mcp-oauth.config';
import { McpOAuthProviderService } from './mcp-oauth-provider.service';
import { OAuthPagesService } from './oauth-pages.service';

type InteractionDetails = Awaited<
  ReturnType<McpOAuthProviderService['provider']['interactionDetails']>
>;

const INVALID_CREDENTIALS_MESSAGE =
  'That email or username and password do not match.';
const EMAIL_NOT_VERIFIED_MESSAGE =
  'Verify your email address before signing in. Check your inbox for the link.';

/**
 * The sign-in and consent steps of the MCP OAuth flow — the pages the
 * provider sends the browser to (`interactions.url`). Each sign-in attempt is
 * one interaction, bound to the browser that started it by the provider's
 * cookie; every form also carries that attempt's anti-forgery token
 * (`OAuthPagesService.formToken`).
 *
 * Sign-in uses the REST login's own check (`AuthService.verifyCredentials`):
 * the same timing-equalised password comparison, the same refusal of inactive
 * and unverified accounts, the same per-identifier throttle and Turnstile. It
 * creates no REST session — it only tells the provider who signed in.
 */
@ApiExcludeController()
@Controller('oauth/interaction')
@Public()
export class OAuthInteractionController {
  constructor(
    private readonly oauthProvider: McpOAuthProviderService,
    private readonly pages: OAuthPagesService,
    private readonly authService: AuthService,
  ) {}

  @Get(':uid')
  @Throttle({ default: MCP_OAUTH_THROTTLE.page })
  async show(
    @Param('uid') uid: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const details = await this.loadInteraction(uid, request, response);
    if (!details) return;
    if (details.prompt.name === 'login') {
      if (!this.pages.isSignInAvailable) {
        this.pages.render(
          response,
          'message',
          {
            title: 'Sign-in unavailable',
            message:
              'Signing in is not available right now because the bot check is not fully configured. Contact the administrator of this service.',
          },
          { status: 503 },
        );
        return;
      }
      await this.renderLogin(details, response);
      return;
    }
    await this.renderConsent(details, response);
  }

  @Post(':uid/login')
  @RequireTurnstile()
  @ThrottleSignIn()
  async login(
    @Param('uid') uid: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const details = await this.loadInteraction(uid, request, response, 'login');
    if (!details) return;
    const body = request.body as Record<string, unknown>;
    const identifier =
      typeof body.identifier === 'string' ? body.identifier : '';
    const password = typeof body.password === 'string' ? body.password : '';
    try {
      const user = await this.authService.verifyCredentials(
        identifier,
        password,
      );
      // `ts` is the sign-in time every later account check compares with the
      // account's session cutoff.
      const result: InteractionResults = {
        login: { accountId: user.id, ts: Math.floor(Date.now() / 1000) },
      };
      await this.oauthProvider.provider.interactionFinished(
        request,
        response,
        result,
        {
          mergeWithLastSubmission: false,
        },
      );
    } catch (error) {
      const message = signInFailureMessage(error);
      if (message === null) throw error;
      await this.renderLogin(details, response, {
        error: message,
        identifier,
        status: 400,
      });
    }
  }

  @Post(':uid/confirm')
  @Throttle({ default: MCP_OAUTH_THROTTLE.page })
  async confirm(
    @Param('uid') uid: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const details = await this.loadInteraction(
      uid,
      request,
      response,
      'consent',
    );
    if (!details) return;
    const body = request.body as Record<string, unknown>;
    if (body.decision !== 'approve') {
      await this.deny(request, response);
      return;
    }
    const { provider } = this.oauthProvider;
    const accountId = details.session?.accountId;
    const clientId = details.params.client_id as string;
    // The account is checked once more, against the time this browser signed
    // in: it may have been deactivated, or had its sessions ended (sign-out
    // everywhere, a password change), between signing in and approving.
    const signedInAt = await this.oauthProvider.sessionSignedInAt(
      details.session?.cookie,
    );
    const account =
      accountId && signedInAt !== undefined
        ? await this.oauthProvider.findUsableAccount(accountId, signedInAt)
        : null;
    if (!account) {
      await this.deny(request, response);
      return;
    }
    const grant = details.grantId
      ? await provider.Grant.find(details.grantId)
      : new provider.Grant({ accountId: account.id, clientId });
    if (!grant) {
      await this.deny(request, response);
      return;
    }
    const missing = details.prompt.details as {
      missingOIDCScope?: string[];
      missingResourceScopes?: Record<string, string[]>;
    };
    if (missing.missingOIDCScope?.length) {
      grant.addOIDCScope(missing.missingOIDCScope.join(' '));
    }
    for (const [indicator, scopes] of Object.entries(
      missing.missingResourceScopes ?? {},
    )) {
      grant.addResourceScope(indicator, scopes.join(' '));
    }
    const grantId = await grant.save();
    await provider.interactionFinished(
      request,
      response,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  }

  /** "Cancel" on the sign-in page: the client receives `access_denied`. */
  @Post(':uid/abort')
  @Throttle({ default: MCP_OAUTH_THROTTLE.page })
  async abort(
    @Param('uid') uid: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const details = await this.loadInteraction(uid, request, response);
    if (!details) return;
    await this.deny(request, response);
  }

  private async deny(request: Request, response: Response): Promise<void> {
    await this.oauthProvider.provider.interactionFinished(
      request,
      response,
      {
        error: 'access_denied',
        error_description: 'The user did not allow access.',
      },
      { mergeWithLastSubmission: false },
    );
  }

  /**
   * The interaction this browser started, or `null` after answering the
   * request itself. A POST must also carry the attempt's form token and be
   * for the step the interaction is waiting on.
   */
  private async loadInteraction(
    uid: string,
    request: Request,
    response: Response,
    expectedPrompt?: 'login' | 'consent',
  ): Promise<InteractionDetails | null> {
    let details: InteractionDetails;
    try {
      details = await this.oauthProvider.provider.interactionDetails(
        request,
        response,
      );
    } catch {
      this.renderExpired(response);
      return null;
    }
    if (details.uid !== uid) {
      this.renderExpired(response);
      return null;
    }
    if (request.method === 'POST') {
      const body = request.body as Record<string, unknown> | undefined;
      const isForged = !this.pages.isValidFormToken(uid, body?.formToken);
      const isWrongStep =
        expectedPrompt !== undefined && details.prompt.name !== expectedPrompt;
      if (isForged || isWrongStep) {
        this.pages.render(
          response,
          'message',
          {
            title: 'Request refused',
            message:
              'This form could not be verified. Start the connection again from your application.',
          },
          { status: 403 },
        );
        return null;
      }
    }
    return details;
  }

  private async renderLogin(
    details: InteractionDetails,
    response: Response,
    extra: { error?: string; identifier?: string; status?: number } = {},
  ): Promise<void> {
    const client = await this.oauthProvider.provider.Client.find(
      details.params.client_id as string,
    );
    const base = `${MCP_OAUTH_PATHS.interaction}/${details.uid}`;
    this.pages.render(
      response,
      'login',
      {
        title: 'Sign in',
        clientName: client?.clientName ?? 'An application',
        action: `${base}/login`,
        abortAction: `${base}/abort`,
        formToken: this.pages.formToken(details.uid),
        error: extra.error,
        identifier: extra.identifier,
      },
      {
        status: extra.status,
        redirectUri: details.params.redirect_uri as string | undefined,
      },
    );
  }

  private async renderConsent(
    details: InteractionDetails,
    response: Response,
  ): Promise<void> {
    const { provider } = this.oauthProvider;
    const client = await provider.Client.find(
      details.params.client_id as string,
    );
    const accountId = details.session?.accountId;
    const account = accountId
      ? await this.oauthProvider.findUsableAccount(accountId, undefined)
      : null;
    // The redirect URI shown is the one this request uses, which the provider
    // has already matched exactly against the client's registration.
    const redirectUri = details.params.redirect_uri as string;
    this.pages.render(
      response,
      'consent',
      {
        title: 'Allow access',
        clientName: client?.clientName ?? 'Unnamed application',
        redirectUri,
        userEmail: account?.email ?? '',
        action: `${MCP_OAUTH_PATHS.interaction}/${details.uid}/confirm`,
        formToken: this.pages.formToken(details.uid),
      },
      { redirectUri },
    );
  }

  private renderExpired(response: Response): void {
    this.pages.render(
      response,
      'message',
      {
        title: 'Sign-in expired',
        message:
          'This sign-in has expired or was opened in another browser. Start the connection again from your application.',
      },
      { status: 400 },
    );
  }
}

/** The page message for an expected sign-in refusal; `null` for anything else. */
function signInFailureMessage(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse() as { errorCode?: string } | string;
  const errorCode = typeof body === 'object' ? body.errorCode : undefined;
  if (errorCode === ErrorCode.INVALID_CREDENTIALS)
    return INVALID_CREDENTIALS_MESSAGE;
  if (errorCode === ErrorCode.EMAIL_NOT_VERIFIED)
    return EMAIL_NOT_VERIFIED_MESSAGE;
  return null;
}
