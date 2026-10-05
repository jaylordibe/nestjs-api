import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { RedisService } from '../redis/redis.service';
import { formatErrorMessage } from '../util/error-message.util';
import { SEND_LIMITS, SendPurpose } from './send-limit.config';

// Labels the key-derivation step, so this HMAC key can never equal one derived
// from JWT_SECRET for any other purpose. Rotating JWT_SECRET therefore resets
// every destination's budget — at most one window of extra sends.
const KEY_DERIVATION_LABEL = 'destination-send-limit';

// Gives a unit back only while a window is open. A bare DECR after the key
// expired would recreate it at -1 with no TTL: the next window would allow one
// extra send, and a destination never seen again would leave the key behind for
// good. (If the send outlived its own window and a new one has opened, the unit
// lands in the new window — at most one extra send per such failure.)
const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/** A destination's budget, reserved for one send. */
export interface SendReservation {
  readonly key: string;
}

/**
 * Caps how many messages one destination — an email address or a phone number
 * — receives per purpose per window, whoever asks for them.
 *
 * Callers reserve BEFORE minting any token or code, so a refused send leaves
 * the one the person already received valid, and the send runs through
 * `sendReserved`, which gives the reservation back if it fails, so a provider
 * error and its retries do not use up the budget. A refusal is never shown to
 * the requester: the caller skips the send and answers as usual.
 *
 * The counter lives in Redis under an HMAC of the destination, never the
 * destination itself — an unsalted hash of a phone number is reversed by
 * enumerating the number space. Redis errors propagate: what an outage means
 * (refuse an SMS, retry an email job) is the caller's decision.
 *
 * Every email or SMS a request can cause goes through this service, apart
 * from the exceptions the "Rate limiting" convention in AGENTS.md names.
 */
@Injectable()
export class DestinationSendLimitService {
  private readonly logger = new Logger(DestinationSendLimitService.name);
  private readonly keyDerivationKey: Buffer;

  constructor(
    private readonly redis: RedisService,
    configService: ConfigService,
  ) {
    this.keyDerivationKey = createHmac(
      'sha256',
      configService.getOrThrow<string>('jwt.secret'),
    )
      .update(KEY_DERIVATION_LABEL)
      .digest();
  }

  /**
   * Counts one send to `destination` and returns the reservation, or null
   * when the destination has used its budget for this window. `destination`
   * must already be canonical (see message-destination.util.ts for email; a
   * phone number is its validated E.164 form).
   */
  async reserve(
    purpose: SendPurpose,
    destination: string,
  ): Promise<SendReservation | null> {
    const { limit, windowSeconds } = SEND_LIMITS[purpose];
    const key = this.keyFor(purpose, destination);
    // INCR and the expiry in one transaction: two concurrent sends must not
    // both read "under the limit", and the window starts at the first send
    // (`NX`) rather than sliding forward with every attempt.
    const results = await this.redis.client
      .multi()
      .incr(key)
      .expire(key, windowSeconds, 'NX')
      .exec();
    if (!results) throw new Error('Redis transaction was aborted');
    // Both replies matter: a counter whose expiry failed never resets, and
    // the destination would be refused for good.
    for (const [replyError] of results) {
      if (replyError) throw replyError;
    }

    if (Number(results[0]?.[1]) > limit) {
      // The key, never the destination: logs are a sink for personal data too.
      this.logger.warn(
        `Destination send limit reached: purpose=${purpose} key=${key.slice(-12)}`,
      );
      return null;
    }
    return { key };
  }

  /**
   * Whether `destination` still has budget for `purpose`, WITHOUT counting a
   * send. For a caller that must decide before an irreversible step it cannot
   * defer to the send itself — e.g. rotating an invitation token, which kills
   * the link the invitee already holds. Advisory: the send still reserves.
   */
  async hasBudget(purpose: SendPurpose, destination: string): Promise<boolean> {
    const count = await this.redis.client.get(
      this.keyFor(purpose, destination),
    );
    return Number(count ?? 0) < SEND_LIMITS[purpose].limit;
  }

  /**
   * Runs a reserved send, giving the reservation back if the send throws. The
   * send's own error is rethrown; a failed give-back only costs the
   * destination one unit until the window ends.
   */
  async sendReserved(
    reservation: SendReservation,
    send: () => Promise<void>,
  ): Promise<void> {
    try {
      await send();
    } catch (error) {
      await this.redis.client
        .eval(RELEASE_SCRIPT, 1, reservation.key)
        .catch((releaseError: unknown) =>
          this.logger.warn(
            `Could not release a send reservation: ${formatErrorMessage(releaseError)}`,
          ),
        );
      throw error;
    }
  }

  /**
   * Reserves, then runs `send` — which mints any token and sends — through
   * `sendReserved`. False when the destination is over its limit, in which
   * case `send` never runs. A Redis failure throws.
   */
  async sendWithinLimit(
    purpose: SendPurpose,
    destination: string,
    send: () => Promise<void>,
  ): Promise<boolean> {
    const reservation = await this.reserve(purpose, destination);
    if (!reservation) return false;
    await this.sendReserved(reservation, send);
    return true;
  }

  private keyFor(purpose: SendPurpose, destination: string): string {
    const digest = createHmac('sha256', this.keyDerivationKey)
      .update(destination)
      .digest('hex');
    return `send-limit:${purpose}:${digest}`;
  }
}
