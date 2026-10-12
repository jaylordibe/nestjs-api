import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../errors/errors';
import { formatErrorMessage } from '../util/error-message.util';
import {
  PROVIDER_FAILURE_THRESHOLD,
  TurnstileCircuitBreaker,
} from './turnstile-circuit-breaker';

// Cloudflare Turnstile: the client's widget mints a short-lived, single-use
// token, and this service asks Cloudflare's siteverify whether it is genuine
// before a protected action runs.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Two widgets per environment, each with its own secret: `web` for the website
// and `mobile` for the app. A token only verifies against the secret of the
// widget that minted it, so the wrong choice fails closed. TurnstileGuard picks
// the widget.
//
// Outcomes:
//   - verdict, success                       → the action runs.
//   - verdict, refused token                 → 400 TURNSTILE_TOKEN_INVALID.
//   - verdict or 4xx saying OUR request is   → 503, logged at ERROR, never
//     wrong (bad secret, malformed call)       bypassed: see the breaker.
//   - no answer (unreachable, timeout, 5xx,  → 503 for the first few; then the
//     `internal-error`, unreadable body)       audited bypass of the breaker.

export type TurnstileWidget = 'web' | 'mobile';

export const TURNSTILE_BYPASS_AUDIT_ACTION = 'turnstile.verification_bypassed';

// Cloudflare's documented maximum token length. Anything longer cannot be
// genuine, so it is refused without a call out.
export const MAX_TURNSTILE_TOKEN_LENGTH = 2048;

// A code constant, never configuration: nothing a caller sends can point this
// request anywhere else.
const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Siteverify usually answers in well under a second; past this it counts as
// no answer.
const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

// The only refusals a client can fix — by getting a new token. Cloudflare's
// `internal-error` is its own failure, a no-answer; every other error code is
// about our own request (the secret, the call itself).
const TOKEN_FAULT_ERROR_CODES: ReadonlySet<string> = new Set([
  'missing-input-response',
  'invalid-input-response',
  'timeout-or-duplicate',
]);

const UNAVAILABLE_MESSAGE =
  'The bot check is temporarily unavailable. Please try again.';

type SiteverifyOutcome =
  | { kind: 'verdict'; isSuccess: boolean; errorCodes: string[] }
  | { kind: 'no-answer'; reason: string }
  | { kind: 'our-request-refused'; reason: string };

@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secretKeys: Record<TurnstileWidget, string | undefined>;
  // One breaker for both widgets: the failure it guards is reaching the same
  // host, whichever secret the request would have used.
  private readonly circuitBreaker = new TurnstileCircuitBreaker();

  constructor(
    configService: ConfigService,
    private readonly auditService: AuditService,
  ) {
    // Optional by design (off locally and in tests), hence `get`: env
    // validation requires both in staging and production, and both or neither
    // everywhere.
    this.secretKeys = {
      web: configService.get<string>('turnstile.webSecretKey'),
      mobile: configService.get<string>('turnstile.mobileSecretKey'),
    };
    if (!this.isEnabled()) {
      this.logger.warn(
        'Turnstile bot check is OFF: TURNSTILE_WEB_SECRET and TURNSTILE_MOBILE_SECRET are unset.',
      );
    }
  }

  // Both or neither, never one (env validation): with one widget unconfigured a
  // caller could choose it and skip the check.
  isEnabled(): boolean {
    return Boolean(this.secretKeys.web && this.secretKeys.mobile);
  }

  // Returns when the action may proceed; throws otherwise. Never logs or audits
  // the token.
  async verify(
    token: string,
    widget: TurnstileWidget,
    remoteIp: string | undefined,
  ): Promise<void> {
    if (token.length > MAX_TURNSTILE_TOKEN_LENGTH) {
      throw Errors.turnstileTokenInvalid();
    }

    // Cloudflare is already known not to be answering: skip the call rather
    // than make every request wait out the timeout first.
    if (this.circuitBreaker.shouldBypass(Date.now())) {
      await this.recordBypass(widget, 'circuit open');
      return;
    }

    const outcome = await this.callSiteverify(token, widget, remoteIp);

    if (outcome.kind === 'no-answer') {
      this.logger.warn(
        `Turnstile siteverify gave no answer: ${outcome.reason}`,
      );
      await this.handleNoAnswer(widget, outcome.reason);
      return;
    }

    // Cloudflare answered, even if only to say our request is wrong: the run of
    // no-answers is over.
    if (this.circuitBreaker.recordProviderSuccess()) {
      this.logger.log(
        'Turnstile RECOVERED: siteverify is answering again — tokens are verified again.',
      );
    }

    if (outcome.kind === 'our-request-refused') {
      this.logOurRequestRefused(widget, outcome.reason);
      throw Errors.externalServiceUnavailable(UNAVAILABLE_MESSAGE);
    }

    if (outcome.isSuccess) return;

    const errorCodes = outcome.errorCodes.join(',') || '<no error codes>';
    const blamesOurRequest = outcome.errorCodes.some(
      (code) => code !== 'internal-error' && !TOKEN_FAULT_ERROR_CODES.has(code),
    );
    if (blamesOurRequest) {
      this.logOurRequestRefused(widget, errorCodes);
      throw Errors.externalServiceUnavailable(UNAVAILABLE_MESSAGE);
    }

    // Not a warning: an expired token or a double submit is an ordinary user
    // event, not an operational problem.
    this.logger.log(`Turnstile refused a ${widget} token: ${errorCodes}`);
    throw Errors.turnstileTokenInvalid();
  }

  private async callSiteverify(
    token: string,
    widget: TurnstileWidget,
    remoteIp: string | undefined,
  ): Promise<SiteverifyOutcome> {
    const form = new URLSearchParams({
      secret: this.secretKeys[widget] ?? '',
      response: token,
    });
    // Cloudflare scores the token against the address that solved it.
    if (remoteIp) form.append('remoteip', remoteIp);

    let response: Response;
    try {
      response = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      });
    } catch (error) {
      return { kind: 'no-answer', reason: formatErrorMessage(error) };
    }

    if (!response.ok) {
      // Unread, the body would hold its connection until the timeout fires.
      await response.body?.cancel().catch(() => undefined);
      const reason = `HTTP ${response.status}`;
      return response.status >= 500
        ? { kind: 'no-answer', reason }
        : { kind: 'our-request-refused', reason };
    }

    // Read inside the failure path: a 2xx whose body is not a siteverify answer
    // (an edge error page, a body stalled past the timeout) is still no verdict,
    // and must count toward the breaker rather than escape as a 500.
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return {
        kind: 'no-answer',
        reason: `unreadable answer: ${formatErrorMessage(error)}`,
      };
    }
    if (!isSiteverifyAnswer(body)) {
      return { kind: 'no-answer', reason: 'unexpected answer shape' };
    }

    const errorCodes = Array.isArray(body['error-codes'])
      ? body['error-codes'].filter(
          (code): code is string => typeof code === 'string',
        )
      : [];
    // Only when Cloudflare blames nothing but itself. Any other code beside it
    // — a bad token, our bad secret — makes the reply a verdict, so nothing a
    // caller or a misconfiguration controls can count toward the bypass.
    if (
      body.success !== true &&
      errorCodes.length > 0 &&
      errorCodes.every((code) => code === 'internal-error')
    ) {
      return { kind: 'no-answer', reason: 'internal-error' };
    }
    return { kind: 'verdict', isSuccess: body.success === true, errorCodes };
  }

  // Either engages the bypass (returns, so the request proceeds unverified) or
  // fails closed (throws 503). Nothing is left for the caller to interpret.
  private async handleNoAnswer(
    widget: TurnstileWidget,
    reason: string,
  ): Promise<void> {
    const outcome = this.circuitBreaker.recordProviderFailure(Date.now());

    if (!outcome.isBypassActive) {
      throw Errors.externalServiceUnavailable(UNAVAILABLE_MESSAGE);
    }

    if (outcome.hasJustOpened) {
      this.logger.error(
        `Turnstile DEGRADED: ${PROVIDER_FAILURE_THRESHOLD} consecutive no-answers ` +
          `(${reason}). Skipping verification of token-bearing requests until ` +
          `siteverify answers again. Per-IP throttles and per-destination send ` +
          `limits stay in force.`,
      );
    }

    await this.recordBypass(widget, reason);
  }

  // A skipped check is never silent: an ERROR line to alert on, and one audit
  // row per request so an incident review can list exactly what got through.
  // No row, no skip — a bypass that cannot be recorded is refused.
  private async recordBypass(
    widget: TurnstileWidget,
    reason: string,
  ): Promise<void> {
    const auditLogId = await this.auditService.record({
      action: TURNSTILE_BYPASS_AUDIT_ACTION,
      actorId: null,
      metadata: { widget, reason },
    });
    if (auditLogId === null) {
      this.logger.error(
        `Turnstile verification NOT bypassed (${widget}): the audit row could not be written — refused.`,
      );
      throw Errors.externalServiceUnavailable(UNAVAILABLE_MESSAGE);
    }
    this.logger.error(
      `Turnstile verification BYPASSED (${widget}): siteverify not answering — ${reason}`,
    );
  }

  private logOurRequestRefused(widget: TurnstileWidget, reason: string): void {
    this.logger.error(
      `Turnstile siteverify refused OUR request (${reason}) — check the ${widget} widget's secret key for this environment, or whether Cloudflare is rate-limiting this server.`,
    );
  }
}

function isSiteverifyAnswer(
  body: unknown,
): body is { success: boolean; 'error-codes'?: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { success?: unknown }).success === 'boolean'
  );
}
