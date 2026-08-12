import type { ConfigService } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';
import { parseRedisUrl, redactRedisUrl } from '../util/redis-url.util';

// ── THE Redis connection builder ─────────────────────────────────────────────
// Every Redis client in this application is configured from here: the shared
// app client (`RedisService`), the throttler's storage client (`app.module.ts`)
// and BullMQ's connection (`queue.module.ts`). There is deliberately no second
// place that calls `new Redis(url)` — a managed Redis with AUTH and in-transit
// encryption fails CLOSED on a client that forgot the TLS half, and the failure
// arrives as a connection error nobody can attribute to a missing option.
//
// What this returns is TRANSPORT only — where to connect, as whom, on which
// logical database, and under what trust anchor. It deliberately does NOT
// decide behavioural options, because they legitimately differ per consumer:
// BullMQ's blocking commands require `maxRetriesPerRequest: null` (a
// per-request retry ceiling would tear a connection down mid-BRPOPLPUSH),
// whereas the app client wants a bounded ceiling so a misconfiguration surfaces
// instead of buffering forever. Each consumer adds its own on top.
export interface RedisTlsSettings {
  readonly isEnabled: boolean;
  // PEM-encoded CA bundle for verifying the server certificate. Undefined means
  // "use Node's bundled trust store", which is correct for a Redis fronted by a
  // publicly-trusted certificate and wrong for a managed Redis whose server CA
  // is private or per-instance and must be supplied.
  readonly certificateAuthority: string | undefined;
}

// Secret Manager, `env_file` and GitHub Actions all round-trip a PEM through a
// single-line string, so the newlines arrive as the two characters `\` `n`.
// Node's TLS parser rejects that silently-looking-fine value with an opaque
// error, so normalise both spellings here rather than making every operator
// discover it.
function normalizeCertificateAuthority(certificateAuthority: string): string {
  return certificateAuthority.replace(/\\n/g, '\n').trim();
}

const PEM_CERTIFICATE_HEADER = '-----BEGIN CERTIFICATE-----';

export function buildRedisTransportOptions(
  redisUrl: string,
  tlsSettings: RedisTlsSettings,
): RedisOptions {
  const parsedUrl = parseRedisUrl(redisUrl);

  // The scheme and the flag must agree. They are two independent statements of
  // the same fact, and a deployment where they disagree is a deployment where
  // somebody believes traffic is encrypted and it is not — the single most
  // expensive way for this to be wrong. Refuse rather than pick a winner.
  if (tlsSettings.isEnabled && !parsedUrl.isSecureScheme) {
    throw new Error(
      `REDIS_TLS_ENABLED is true but REDIS_URL uses the plaintext redis:// scheme (${redactRedisUrl(redisUrl)}). Use rediss:// for an encrypted connection.`,
    );
  }
  if (!tlsSettings.isEnabled && parsedUrl.isSecureScheme) {
    throw new Error(
      `REDIS_URL uses rediss:// but REDIS_TLS_ENABLED is false (${redactRedisUrl(redisUrl)}). Set REDIS_TLS_ENABLED=true, or use redis:// for a plaintext connection.`,
    );
  }

  const { isSecureScheme, ...connectionOptions } = parsedUrl;
  if (!isSecureScheme) {
    return connectionOptions;
  }

  const certificateAuthority = tlsSettings.certificateAuthority
    ? normalizeCertificateAuthority(tlsSettings.certificateAuthority)
    : undefined;

  if (
    certificateAuthority &&
    !certificateAuthority.includes(PEM_CERTIFICATE_HEADER)
  ) {
    throw new Error(
      `REDIS_TLS_CA is set but does not contain "${PEM_CERTIFICATE_HEADER}" — it must be the PEM-encoded CA certificate, not a path or a fingerprint.`,
    );
  }

  return {
    ...connectionOptions,
    tls: {
      ...(certificateAuthority ? { ca: certificateAuthority } : {}),
      // Never negotiable, and never made configurable. Turning verification off
      // keeps encryption while discarding the only thing that proves the far
      // end is the Redis you meant — which is the whole point of paying for
      // in-transit encryption in the first place.
      rejectUnauthorized: true,
    },
  };
}

export function buildRedisConnectionOptions(
  configService: ConfigService,
): RedisOptions {
  return buildRedisTransportOptions(
    configService.getOrThrow<string>('redis.url'),
    {
      isEnabled: configService.getOrThrow<boolean>('redis.tls.enabled'),
      certificateAuthority: configService.get<string>(
        'redis.tls.certificateAuthority',
      ),
    },
  );
}
