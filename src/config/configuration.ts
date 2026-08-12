export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  serviceName: string;
  port: number;
  apiBaseUrl: string;
  // Customer-facing web frontend base URL. Distinct from `apiBaseUrl`
  // (the API) — emails that link the customer to a page they actually
  // browse (booking confirmation CTAs, marketing links, etc.) compose
  // their hrefs from `webBaseUrl + path`. No trailing slash.
  webBaseUrl: string;
  // Commit hash of the build that produced the running container.
  // Populated by the deploy workflows via a Docker build arg → ENV;
  // defaults to 'unknown' for local dev. Surfaced in the Swagger doc
  // version so deploys are unambiguously verifiable.
  gitSha: string;
  database: {
    url: string;
    name: string;
    // Connections THIS process may hold open to Postgres. Explicit because the
    // API autoscales horizontally: the cluster's real demand is
    // `max instances × poolMax`, plus every worker instance's pool, plus
    // whatever a migration job takes — and that total has to stay under the
    // database's own connection limit. An implicit default is a number nobody
    // chose being multiplied by an autoscaler.
    poolMax: number;
    // How long a caller waits for a free connection before failing. Bounded so
    // a saturated pool surfaces as a fast error rather than a request that
    // hangs until the client gives up.
    connectionTimeoutMs: number;
    // How long an idle connection is kept before being returned to the
    // database. Short enough that a scaled-down instance stops occupying
    // connections other instances need.
    idleTimeoutMs: number;
  };
  redis: {
    host: string;
    port: number;
    password: string;
    url: string;
    tls: {
      // Whether to dial over TLS. Must agree with REDIS_URL's scheme — see
      // `common/redis/redis-connection.ts`, which refuses a disagreement rather
      // than picking a winner.
      enabled: boolean;
      // PEM-encoded CA bundle. Required for a managed Redis whose server
      // certificate is signed by a private or per-instance CA; omit when the
      // certificate chains to a publicly-trusted root. Certificate
      // verification is NOT configurable and is always on.
      certificateAuthority: string | undefined;
    };
  };
  queue: {
    // Whether THIS process consumes queued jobs. False makes it a pure
    // producer — it still enqueues everything, the jobs just wait in Redis for
    // a process that does consume. That is what lets one image run as an
    // API-only instance, a worker-only instance, or both at once locally.
    // Producing is never gated; only consuming.
    workerEnabled: boolean;
    // Jobs a worker runs at once, per queue. The ops lever for queue backlog —
    // raise it when jobs pile up, lower it when they crowd out HTTP traffic in
    // a combined API+worker process. A queue may pin its own value in
    // QUEUE_REGISTRATIONS when its jobs are heavy enough to warrant it.
    workerConcurrency: number;
  };
  jwt: {
    secret: string;
    // Access-token lifetime. Deliberately short: an access token is stateless
    // and therefore cannot be withdrawn once issued, so its blast radius is
    // bounded by its expiry and nothing else. The refresh token below is the
    // long-lived half, and it IS revocable.
    expiresIn: string;
    // Refresh-token lifetime, in whole days — the real "stay signed in" window.
    refreshExpiresInDays: number;
  };
  authorization: {
    // How long a user's compiled permission grants stay cached in Redis.
    // This is a BACKSTOP, not the correctness mechanism: every role or
    // membership change explicitly invalidates the affected key(s), so the
    // TTL only bounds the damage from a missed invalidation.
    grantsCacheTtlSeconds: number;
  };
  cloudflare: {
    // Whether `CF-Connecting-IP`, `CF-IPCountry`, and `CF-Ray` may be believed.
    //
    // They are ordinary request headers: anyone who can reach the origin
    // directly can set them to anything, and they are recorded into
    // `audit_logs` — the table an incident responder trusts. Enable ONLY when
    // the origin is provably unreachable except through Cloudflare (see the
    // `cloudflare_only` snippet in docs/prod/Caddyfile).
    trustHeaders: boolean;
  };
  businessInvitation: {
    // How long an invitation token stays redeemable. Bounded because the token
    // is a bearer credential sitting in somebody's inbox: the longer it lives,
    // the longer a forwarded or breached mailbox is a way into the business.
    expiresInDays: number;
  };
  email: {
    provider: 'stub' | 'resend';
    from: string | undefined;
    resendApiKey: string | undefined;
  };
  sms: {
    provider: 'stub' | 'twilio';
    twilioAccountSid: string | undefined;
    twilioAuthToken: string | undefined;
    twilioFrom: string | undefined;
  };
  storage: {
    // Which object-storage adapter is active. `stub` persists nothing and is
    // the default, so a fresh clone and the whole test suite need no cloud
    // account. The rest are equal citizens — no provider is privileged, and
    // only the selected one's SDK is ever loaded.
    provider: 'stub' | 's3' | 'gcs' | 'azure';
    // Public URL prefix for stored objects, applied by EVERY adapter.
    //
    // Undefined is the default and the safe case: `resolvePublicUrl` then
    // returns null and callers must use a signed URL. Setting this is an
    // explicit assertion that the bucket/container is world-readable or
    // CDN-fronted. Nothing in this application makes storage public.
    publicUrlBase: string | undefined;
    // Default lifetime for a signed read URL. Clamped by
    // `resolveSignedUrlTtlSeconds` regardless of what is configured here — a
    // signed URL cannot be revoked, so its lifetime is its whole security
    // boundary.
    signedUrlTtlSeconds: number;
    // Ceiling on any single call to the storage backend. Explicit because
    // CLAUDE.md requires one on every remote operation, and because the failure
    // it guards is a SLOW backend rather than a dead one: an upload handler
    // awaiting a hung request holds its Postgres connection for as long as it
    // waits, so a stalled bucket saturates the database pool and takes down
    // requests that never touched storage.
    requestTimeoutMs: number;
    // Provider-specific blocks. Each is read ONLY by its own adapter, and only
    // when that adapter is selected. Notice what is absent from all three:
    // credentials. Every adapter authenticates through its platform's keyless
    // identity chain, so there is no place here for a long-lived key to live.
    s3: {
      bucket: string | undefined;
      // Optional — the SDK resolves it from AWS_REGION, shared config or
      // instance metadata when unset.
      region: string | undefined;
      // Set for an S3-compatible backend (Cloudflare R2, DigitalOcean Spaces,
      // MinIO, Ceph). Leave unset for AWS S3 itself.
      endpoint: string | undefined;
      // Path-style addressing (`https://endpoint/bucket/key`). Required by some
      // self-hosted S3-compatible servers.
      forcePathStyle: boolean;
    };
    gcs: {
      bucket: string | undefined;
      // Optional. Supplied explicitly it pins the project; omitted, ADC decides
      // — which is what a local `gcloud auth` session expects.
      projectId: string | undefined;
    };
    azure: {
      accountName: string | undefined;
      container: string | undefined;
    };
  };
  swagger: {
    // Whether `/api/docs` is served. Production is hard-OFF and cannot be
    // turned on by configuration — the schema dump describes every DTO and
    // every route to anonymous traffic, and there is no deployment of this
    // template where that belongs on the customer-facing host.
    //
    // SWAGGER_ENABLED only lets a NON-production environment turn it off. It
    // exists because staging used to be protected by Basic Auth at the reverse
    // proxy, and a staging service on a platform with no proxy in front of it
    // has no such protection — so the switch has to live in the application.
    enabled: boolean;
  };
  cors: {
    origin: string;
  };
  throttle: {
    ttlMs: number;
    limit: number;
  };
  trustProxy: boolean | number | string;
  // Public web URL the API redirects to after a GET /auth/verify-email
  // click. The web app reads `?status=success|error&reason=…` and
  // renders the matching state. Optional in dev (defaults to a stub
  // page on `webBaseUrl`); production should set this to the real
  // verify-email landing page on the web frontend.
  emailVerifiedRedirectUrl: string;
}

const parseTrustProxy = (raw: string): boolean | number | string => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
};

export default (): AppConfig => ({
  nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
  serviceName: process.env.SERVICE_NAME!,
  port: parseInt(process.env.PORT ?? '3000', 10),
  apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:3000/api',
  webBaseUrl: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
  gitSha: process.env.GIT_SHA ?? 'unknown',
  database: {
    url: process.env.DATABASE_URL!,
    name: process.env.DB_NAME!,
    poolMax: parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10),
    connectionTimeoutMs: parseInt(
      process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? '5000',
      10,
    ),
    idleTimeoutMs: parseInt(
      process.env.DATABASE_IDLE_TIMEOUT_MS ?? '30000',
      10,
    ),
  },
  redis: {
    host: process.env.REDIS_HOST!,
    port: parseInt(process.env.REDIS_PORT!, 10),
    password: process.env.REDIS_PASSWORD!,
    url: process.env.REDIS_URL!,
    tls: {
      // Trimmed and lowercased rather than compared to a bare 'true', for the
      // same reason as `queue.workerEnabled` below: Joi's coerced boolean does
      // not necessarily reach `process.env`, so the RAW string is what arrives
      // here and ` True ` must not read as false.
      enabled:
        (process.env.REDIS_TLS_ENABLED ?? 'false').trim().toLowerCase() ===
        'true',
      certificateAuthority: process.env.REDIS_TLS_CA || undefined,
    },
  },
  queue: {
    // Trimmed and lowercased before comparing, NOT compared to a bare
    // 'false'. Joi validates this var but its coerced boolean does not
    // necessarily reach `process.env`: @nestjs/config only writes validated
    // values back for keys that were not already present, and every deployed
    // container supplies it through `env_file`, so the RAW string is what
    // arrives here. Joi's boolean is case-insensitive and trims, so it
    // happily accepts `False` / ` false ` — which an exact `!== 'false'`
    // would read as TRUE, silently starting a worker on an instance meant to
    // be a pure producer.
    workerEnabled:
      (process.env.QUEUE_WORKER_ENABLED ?? 'true').trim().toLowerCase() !==
      'false',
    workerConcurrency: parseInt(
      process.env.QUEUE_WORKER_CONCURRENCY ?? '10',
      10,
    ),
  },
  jwt: {
    secret: process.env.JWT_SECRET!,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    refreshExpiresInDays: parseInt(
      process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS ?? '30',
      10,
    ),
  },
  authorization: {
    grantsCacheTtlSeconds: parseInt(
      process.env.AUTHORIZATION_GRANTS_CACHE_TTL_SECONDS ?? '300',
      10,
    ),
  },
  cloudflare: {
    trustHeaders: process.env.TRUST_CLOUDFLARE_HEADERS === 'true',
  },
  businessInvitation: {
    expiresInDays: parseInt(
      process.env.BUSINESS_INVITATION_EXPIRES_IN_DAYS ?? '7',
      10,
    ),
  },
  email: {
    provider: (process.env.EMAIL_PROVIDER as 'stub' | 'resend') ?? 'stub',
    from: process.env.EMAIL_FROM,
    resendApiKey: process.env.RESEND_API_KEY,
  },
  sms: {
    provider: (process.env.SMS_PROVIDER as 'stub' | 'twilio') ?? 'stub',
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || undefined,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || undefined,
    twilioFrom: process.env.TWILIO_FROM || undefined,
  },
  storage: {
    provider:
      (process.env.STORAGE_PROVIDER as AppConfig['storage']['provider']) ??
      'stub',
    publicUrlBase: process.env.STORAGE_PUBLIC_URL_BASE || undefined,
    signedUrlTtlSeconds: parseInt(
      process.env.STORAGE_SIGNED_URL_TTL_SECONDS ?? '300',
      10,
    ),
    requestTimeoutMs: parseInt(
      process.env.STORAGE_REQUEST_TIMEOUT_MS ?? '15000',
      10,
    ),
    s3: {
      bucket: process.env.STORAGE_S3_BUCKET || undefined,
      region: process.env.STORAGE_S3_REGION || undefined,
      endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
      forcePathStyle:
        (process.env.STORAGE_S3_FORCE_PATH_STYLE ?? 'false')
          .trim()
          .toLowerCase() === 'true',
    },
    gcs: {
      bucket: process.env.STORAGE_GCS_BUCKET || undefined,
      projectId: process.env.STORAGE_GCS_PROJECT_ID || undefined,
    },
    azure: {
      accountName: process.env.STORAGE_AZURE_ACCOUNT_NAME || undefined,
      container: process.env.STORAGE_AZURE_CONTAINER || undefined,
    },
  },
  swagger: {
    // Two independent conditions, and the production one is not a default that
    // can be overridden — it is a floor. An operator can only ever narrow this.
    enabled:
      (process.env.NODE_ENV ?? 'development') !== 'production' &&
      (process.env.SWAGGER_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  },
  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
  },
  throttle: {
    ttlMs: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY ?? 'false'),
  emailVerifiedRedirectUrl:
    process.env.EMAIL_VERIFIED_REDIRECT_URL ??
    `${process.env.WEB_BASE_URL ?? 'http://localhost:5173'}/auth/verify-email`,
});
