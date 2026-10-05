import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
} from '@nestjs/throttler';
// Type-only: both appear in a decorated constructor signature, which
// `isolatedModules` requires be imported as types (see AGENTS.md).
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { isAccessTokenPayload } from '../../../common/util/access-token.util';

// Rate-limit bucket key. The stock ThrottlerGuard keys purely on IP, which is
// wrong wherever many people share one address — an office, a campus, a hotel
// or café network, a mobile carrier's NAT. A handful of busy users behind it
// throttles everyone else, and the effect is worst on the chattiest surfaces.
//
// This guard keys an authenticated caller on their USER ID instead, so a
// signed-in user carries their own quota through a shared address. Anonymous
// traffic still keys on IP — that is the only stable identifier a guest has.
//
// `@Public()` routes ALWAYS key on IP, token or not. They are anonymous by
// design (JwtAuthGuard skips them), and they are the routes that send email or
// check a credential. A token there would let one address holding N accounts
// multiply every per-route limit by N — N × resend-verification aimed at one
// victim's inbox — so a token on a public route buys no quota at all.
//
// WHY THE TOKEN IS FULLY VERIFIED HERE, rather than just decoded. The tracker
// key IS the security boundary: if the `sub` claim were trusted without
// checking the signature, anyone could mint a token with a random `sub` per
// request and get a brand-new bucket every time — which doesn't just bypass
// this guard, it removes rate limiting from the application entirely. Decoding
// without verifying would be strictly worse than not doing this at all.
//
// Verification is deliberately duplicated with JwtStrategy rather than reusing
// its result: this guard is registered ahead of JwtAuthGuard (global guards
// run in registration order), so `request.user` is not populated yet when
// this executes. An HMAC verify is microseconds, and it must succeed here on the
// same terms as the real auth path — hence the shared secret, issuer and
// audience from the same config keys, and the shared `isAccessTokenPayload`
// rule. What it does NOT repeat is the strategy's database and Redis checks
// (inactive user, password changed, logged-out jti): this guard runs on every
// request, so it never does I/O.
//
// A failed verify is NOT an auth decision: this guard never rejects a request
// for a bad token. It simply falls back to IP keying and lets JwtAuthGuard
// produce the real 401 downstream, so an expired token still gets throttled
// rather than sailing through unbucketed.
@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
  private readonly jwtSecret: string;
  private readonly jwtIssuerAndAudience: string;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    super(options, storageService, reflector);
    this.jwtSecret = configService.getOrThrow<string>('jwt.secret');
    // `iss` and `aud` are both the service name — see AuthModule's JwtModule
    // registration, which signs them from this same value.
    this.jwtIssuerAndAudience = configService.getOrThrow<string>('serviceName');
  }

  // The throttler always passes the execution context; it is optional only so
  // the override stays assignable to the base signature. Without it the route
  // cannot be shown to be non-public, so the caller is keyed on IP.
  protected override async getTracker(
    request: Request,
    context?: ExecutionContext,
  ): Promise<string> {
    const userId =
      context && !this.isPublicRoute(context)
        ? await this.resolveAuthenticatedUserId(request)
        : null;
    // Namespaced so a user id can never collide with an IP literal, and so a
    // key is self-describing when read straight out of Redis. The IP half is
    // the library's own tracker, which folds an IPv6 address to its /64 and
    // unwraps IPv4-mapped addresses — a raw `request.ip` would hand an IPv6
    // client a fresh bucket for every address in its prefix.
    return userId ? `user:${userId}` : `ip:${await super.getTracker(request)}`;
  }

  private isPublicRoute(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  // Returns the caller's user id when the request carries a VALID access token,
  // otherwise null. Never throws — see the class header on why a bad token
  // degrades to IP keying rather than rejecting here.
  private async resolveAuthenticatedUserId(
    request: Request,
  ): Promise<string | null> {
    // Scheme matching is case-insensitive and tolerates any whitespace, to
    // stay in lockstep with passport-jwt, which parses with /(\S+)\s+(\S+)/ and
    // lowercases the scheme. A stricter check here would silently disagree with
    // the auth path: a client sending `bearer <token>` or a tab separator would
    // be authenticated by JwtAuthGuard yet bucketed by IP here, quietly losing
    // its private quota with nothing in the logs to explain it.
    const bearerToken = /^bearer\s+(\S+)\s*$/i.exec(
      request.headers.authorization ?? '',
    )?.[1];
    if (!bearerToken) return null;

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub?: string;
        act?: string;
        purpose?: string;
      }>(bearerToken, {
        secret: this.jwtSecret,
        issuer: this.jwtIssuerAndAudience,
        audience: this.jwtIssuerAndAudience,
        // Pinned rather than inferred. jsonwebtoken@9 already derives
        // HS-only from a string secret, so this changes nothing today — it
        // is here so that swapping to an asymmetric key later cannot
        // silently widen the accepted set and open HS/RS confusion.
        algorithms: ['HS256'],
      });
      // A verification-link token is signed with the same keys but is not an
      // access token: JwtStrategy refuses it, so it gets no private bucket.
      if (!isAccessTokenPayload(payload)) return null;
      // Impersonated traffic buckets on the ACTOR, never on the user whose id
      // `sub` carries. Keying on `sub` would let one administrator exhaust a
      // real user's quota and lock them out of their own account for the
      // window — repeatable, and invisible to the user, who just sees 429s.
      // That is an availability attack, not a fairness nit. This template
      // mints no `act` claim; a fork that adds impersonation inherits the
      // right keying without touching this guard.
      //
      // `act` is read straight off the payload this method has ALREADY fully
      // verified, so this costs nothing. It must stay that way: this guard is
      // global and runs on every request in the application — including guests,
      // `@Public()` routes and requests about to 401 — so a database lookup
      // here would put a query in front of all traffic, and `getTracker` cannot
      // throw today, so a failing query would 500 the entire API rather than
      // 401 one request.
      return payload.act ?? payload.sub ?? null;
    } catch {
      // Expired, forged, or malformed — all treated the same: this caller gets
      // no private quota and is bucketed by IP like any other guest.
      return null;
    }
  }
}
