import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),

  SERVICE_NAME: Joi.string()
    .pattern(/^[a-z][a-z0-9_-]*$/)
    .required()
    .description(
      'lowercase identifier; also used as the Postgres database name',
    ),

  // Base URL used to build clickable links embedded in outbound emails
  // (e.g. the email-verification link). Point this at your frontend if
  // you have one (e.g. `https://app.yourapp.com`); otherwise point it at
  // the API base (e.g. `https://api.yourapp.com/api`) and the backend's
  // `GET /auth/verify-email?token=…` endpoint will handle the click.
  // Must be a full URL with scheme — no trailing slash.
  API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/[^/]$/, { name: 'no-trailing-slash' })
    .default('http://localhost:3000/api'),

  // Customer-facing web frontend base URL — distinct from API_BASE_URL
  // (which is the API). Used by emails that link customers to pages
  // they actually browse (booking confirmation CTAs, marketing pages,
  // etc.). Default targets the Vite dev port; production must set this
  // to the real web hostname (e.g. `https://yourapp.com`).
  WEB_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/[^/]$/, { name: 'no-trailing-slash' })
    .default('http://localhost:5173'),

  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').required(),
  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().required(),
  DB_NAME: Joi.string()
    .pattern(/^[a-z][a-z0-9_-]*$/)
    .required()
    .description('Postgres database name; defaults to ${SERVICE_NAME}'),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),

  // Connections THIS process may hold open to Postgres.
  //
  // The number that matters is not this one, it is the product:
  //
  //   (API max instances × DATABASE_POOL_MAX)
  //     + (worker max instances × DATABASE_POOL_MAX)
  //     + migration job connections
  //     + any interactive/admin session
  //     < the database's max_connections (minus its superuser reserve)
  //
  // Autoscaling is what makes an implicit default dangerous: the per-process
  // number is multiplied by something nobody sets in this file. Capped at 100
  // because a single process wanting more than that is a sign the work belongs
  // on the queue, not in more connections.
  DATABASE_POOL_MAX: Joi.number().integer().min(1).max(100).default(10),
  // How long a caller waits for a free connection before failing. Bounded so a
  // saturated pool surfaces as a fast error instead of a request that hangs
  // until the client times out — and so an instance cannot sit past its own
  // request deadline waiting for a connection that is not coming.
  DATABASE_CONNECTION_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(60_000)
    .default(5_000),
  // How long an idle connection is held before being returned to the database.
  // Short enough that an instance that has scaled down its traffic stops
  // occupying connections its siblings need.
  DATABASE_IDLE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600_000)
    .default(30_000),

  REDIS_HOST: Joi.string().hostname().required(),
  REDIS_PORT: Joi.number().port().required(),
  REDIS_PASSWORD: Joi.string().min(16).required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required()
    // The scheme and REDIS_TLS_ENABLED must agree. Checked here as well as in
    // `buildRedisTransportOptions` so the failure lands at config validation
    // with the variable named, rather than at the first connection attempt.
    .when('REDIS_TLS_ENABLED', {
      is: 'true',
      then: Joi.string()
        .pattern(/^rediss:\/\//)
        .messages({
          'string.pattern.base':
            'REDIS_TLS_ENABLED is true, so REDIS_URL must use the rediss:// scheme. A redis:// URL would connect in plaintext.',
        }),
      otherwise: Joi.string()
        .pattern(/^redis:\/\//)
        .messages({
          'string.pattern.base':
            'REDIS_URL uses rediss:// but REDIS_TLS_ENABLED is not true. Set REDIS_TLS_ENABLED=true so the TLS options (CA, verification) are actually applied.',
        }),
    }),

  // Whether to dial Redis over TLS. Required for a managed Redis with
  // in-transit encryption; left off for the local container, which is
  // reachable only on the developer's own machine.
  //
  // Kept in lockstep with REDIS_URL's scheme rather than allowed to disagree
  // with it. Two statements of the same fact that can diverge is how a
  // deployment ends up believing traffic is encrypted when it is not — the one
  // failure here that produces no error and no symptom.
  REDIS_TLS_ENABLED: Joi.string()
    .valid('true', 'false')
    .allow('')
    .default('false'),
  // PEM-encoded CA certificate for verifying the Redis server certificate.
  //
  // OPTIONAL, and optional on purpose: a Redis whose certificate chains to a
  // publicly-trusted root needs nothing here, while a managed Redis that signs
  // with a private or per-instance CA must supply it. Certificate verification
  // itself is NOT configurable — `rejectUnauthorized` is hard-coded true in
  // `common/redis/redis-connection.ts` — so the only question this variable
  // answers is which trust anchor to verify against.
  //
  // Newlines may be literal or backslash-escaped; the builder normalises both,
  // because Secret Manager and `env_file` each flatten a PEM to one line.
  REDIS_TLS_CA: Joi.string()
    .allow('')
    .optional()
    .when('REDIS_TLS_ENABLED', {
      is: 'false',
      // A CA with TLS off is not merely redundant, it is evidence that somebody
      // configured half of an encrypted connection and believes they configured
      // all of it.
      then: Joi.string().valid('').messages({
        'any.only':
          'REDIS_TLS_CA is set but REDIS_TLS_ENABLED is false — the certificate would be ignored and the connection would be plaintext. Set REDIS_TLS_ENABLED=true and use a rediss:// URL.',
      }),
    }),

  // Whether THIS process consumes queued jobs. Producing is never gated, so
  // false yields a pure API instance that still enqueues everything.
  QUEUE_WORKER_ENABLED: Joi.boolean().default(true),
  // Jobs a worker runs concurrently, per queue. The lever for a growing
  // backlog; capped because an unbounded value in a combined API+worker
  // process starves HTTP request handling.
  QUEUE_WORKER_CONCURRENCY: Joi.number().integer().min(1).max(100).default(10),

  JWT_SECRET: Joi.string()
    .min(32)
    .required()
    .invalid(
      // Reject the template's placeholder value verbatim, so a checkout that
      // never rotated it cannot silently deploy with the default secret.
      '136542716fe8f487721f5e2a3b48574cc3282c086487f28600bda8057f37c92e96c58e64ebe347d29517a2862c6694e2',
    )
    .messages({
      'any.invalid':
        'JWT_SECRET is the template default — regenerate with `openssl rand -hex 48`.',
    }),
  // Access-token lifetime. Short by default and deliberately so: a stateless
  // token cannot be withdrawn once signed, so nothing but its expiry bounds a
  // leaked one. Clients are expected to refresh, not to hold this for days.
  JWT_EXPIRES_IN: Joi.string().default('15m'),

  // Refresh-token lifetime in whole days — the actual "keep me signed in"
  // window, and the one users feel. Unlike the access token this IS revocable
  // (see the `refresh_tokens` table), so a long value here is a usability
  // choice rather than an unbounded liability.
  REFRESH_TOKEN_EXPIRES_IN_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(365)
    .default(30),

  // OpenTelemetry collector base URL, e.g. http://otel-collector:4318. Empty
  // disables telemetry entirely — the SDK never starts, so a fresh clone and
  // the e2e suite pay nothing.
  //
  // Read directly from process.env in src/telemetry.ts (which runs before the
  // Nest container exists), NOT through ConfigService. Declared here anyway so
  // it is documented and validated alongside every other key rather than being
  // an undeclared string someone discovers in the source.
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().allow('').default(''),

  // Backstop TTL for the per-user permission-grants cache in Redis. Role and
  // membership changes invalidate explicitly, so this only bounds the window
  // of a missed invalidation. Lower it if you distrust the invalidation paths;
  // raising it past a few minutes trades staleness for very little.
  AUTHORIZATION_GRANTS_CACHE_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3600)
    .default(300),

  // Whether the Cloudflare-injected request headers may be believed.
  //
  // Defaults to `false`, and that default is the point: these headers are
  // forgeable by anyone who can reach the origin directly, and they are
  // persisted into `audit_logs`. A fork that deploys without restricting the
  // origin to Cloudflare's ranges records the IP Express actually saw rather
  // than one the caller chose. Turn it on only alongside the `cloudflare_only`
  // snippet in docs/prod/Caddyfile.
  TRUST_CLOUDFLARE_HEADERS: Joi.string()
    .valid('true', 'false')
    .allow('')
    .default('false'),

  // How long a business invitation stays redeemable. The token is a bearer
  // credential living in somebody's inbox, so this is bounded on purpose: a
  // long-lived invitation turns any later mailbox compromise into a way into
  // the business. Capped at 30 days — anything longer should be re-issued.
  BUSINESS_INVITATION_EXPIRES_IN_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(30)
    .default(7),

  // Email provider selection. `stub` (default) logs to stdout — OTPs are
  // visible in the app log so local flows can be completed manually.
  // `resend` routes through resend.com and requires RESEND_API_KEY and
  // EMAIL_FROM (the latter must be a verified sender on that domain).
  //
  // Refused in production: `StubEmailAdapter` LOGS THE RENDERED MESSAGE at info
  // level, and that body carries the one-time codes and the
  // `verify-email?token=…` link. Shipping it in production would reintroduce
  // the credential-to-stdout class this template works hard to close, through
  // a default nobody chose. Same floor as CORS_ORIGIN and TRUST_PROXY.
  EMAIL_PROVIDER: Joi.string()
    .valid('stub', 'resend')
    .default('stub')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('stub').required().messages({
        'any.invalid':
          'EMAIL_PROVIDER cannot be "stub" in production — the stub adapter writes the full message body, including one-time codes and verification links, to stdout. Configure a real provider.',
      }),
    }),
  // EMAIL_FROM / RESEND_API_KEY tolerate empty strings when EMAIL_PROVIDER is
  // not `resend`, so a committed `.env` template can ship with `RESEND_API_KEY=""`
  // placeholders without breaking boot on the stub provider. The required check
  // only kicks in when resend is actually selected. (Mirrors the SMS/Twilio
  // fields below.)
  EMAIL_FROM: Joi.string().when('EMAIL_PROVIDER', {
    is: 'resend',
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  RESEND_API_KEY: Joi.string().when('EMAIL_PROVIDER', {
    is: 'resend',
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),

  // SMS provider selection. `stub` (default) logs to stdout — OTPs are
  // visible in the app log so local flows can be completed manually.
  // `twilio` routes through twilio.com and requires TWILIO_ACCOUNT_SID,
  // TWILIO_AUTH_TOKEN, and TWILIO_FROM (an E.164 phone number you've
  // provisioned in the Twilio console, or a Messaging Service SID
  // starting with "MG…").
  //
  // Refused in production for the same reason as EMAIL_PROVIDER: the stub
  // adapter logs the message body, which is the OTP.
  SMS_PROVIDER: Joi.string()
    .valid('stub', 'twilio')
    .default('stub')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('stub').required().messages({
        'any.invalid':
          'SMS_PROVIDER cannot be "stub" in production — the stub adapter writes the message body, which is the one-time code, to stdout. Configure a real provider.',
      }),
    }),
  // The Twilio fields tolerate empty strings when SMS_PROVIDER=stub so a
  // committed `.env` template can ship with `TWILIO_FROM=""` placeholders
  // without breaking dev/test boot. The format/required checks only kick
  // in when twilio is actually selected.
  TWILIO_ACCOUNT_SID: Joi.string().when('SMS_PROVIDER', {
    is: 'twilio',
    then: Joi.string()
      .pattern(/^AC[0-9a-fA-F]{32}$/)
      .required()
      .messages({
        'string.pattern.base':
          'TWILIO_ACCOUNT_SID must start with "AC" followed by 32 hex chars.',
      }),
    otherwise: Joi.string().allow('').optional(),
  }),
  TWILIO_AUTH_TOKEN: Joi.string().when('SMS_PROVIDER', {
    is: 'twilio',
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  TWILIO_FROM: Joi.string().when('SMS_PROVIDER', {
    is: 'twilio',
    then: Joi.required(),
    otherwise: Joi.string().allow('').optional(),
  }),

  // ── Object storage ─────────────────────────────────────────────────────────
  // `stub` (default) persists nothing and returns `stub://…` URLs, so a fresh
  // clone and the whole test suite run with no cloud account and no credential.
  // `s3` (AWS S3 and every S3-compatible backend), `gcs` and `azure` are equal
  // citizens — no provider is privileged and only the selected one's SDK is
  // loaded at runtime.
  //
  // NOTICE WHAT IS ABSENT: there is no variable for an access key, a
  // service-account JSON, an account key or a connection string, for any
  // provider. Each adapter authenticates through its platform's keyless
  // identity chain (IAM role / instance profile / IRSA, Application Default
  // Credentials, Managed Identity). Long-lived cloud credentials are not an
  // input this application accepts.
  //
  // Each provider's fields are required ONLY when that provider is selected, so
  // choosing one never forces the others' configuration to exist.
  STORAGE_PROVIDER: Joi.string()
    .valid('stub', 's3', 'gcs', 'azure')
    .default('stub'),

  // Applies to EVERY provider. Leave unset unless the bucket/container really
  // is world-readable or CDN-fronted: unset means `resolvePublicUrl` returns
  // null and callers must mint a short-lived signed URL instead, which is the
  // safe default and the one this template assumes.
  STORAGE_PUBLIC_URL_BASE: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/[^/]$/, { name: 'no-trailing-slash' })
    .allow('')
    .optional(),

  // Default lifetime of a signed read URL. Clamped to [30s, 1h] in code
  // whatever is set here — a signed URL is an unrevocable bearer credential, so
  // its lifetime is the entire security boundary and is not left to
  // configuration alone.
  STORAGE_SIGNED_URL_TTL_SECONDS: Joi.number()
    .integer()
    .min(30)
    .max(3600)
    .default(300),

  // S3 and S3-compatible (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO).
  STORAGE_S3_BUCKET: Joi.string().when('STORAGE_PROVIDER', {
    is: 's3',
    then: Joi.string().min(3).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  // Optional even for `s3`: the SDK resolves the region from AWS_REGION, the
  // shared config file or instance metadata. Requiring it here would break the
  // hosts that already answer the question.
  STORAGE_S3_REGION: Joi.string().allow('').optional(),
  // Set for an S3-compatible backend; leave empty for AWS S3 itself.
  STORAGE_S3_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  STORAGE_S3_FORCE_PATH_STYLE: Joi.string()
    .valid('true', 'false')
    .allow('')
    .default('false'),

  // Google Cloud Storage.
  STORAGE_GCS_BUCKET: Joi.string().when('STORAGE_PROVIDER', {
    is: 'gcs',
    then: Joi.string().min(3).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  // Optional: supplied it pins the project, omitted ADC decides — which is what
  // a local `gcloud auth` session expects.
  STORAGE_GCS_PROJECT_ID: Joi.string().allow('').optional(),

  // Azure Blob Storage.
  STORAGE_AZURE_ACCOUNT_NAME: Joi.string().when('STORAGE_PROVIDER', {
    is: 'azure',
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  STORAGE_AZURE_CONTAINER: Joi.string().when('STORAGE_PROVIDER', {
    is: 'azure',
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').optional(),
  }),

  // Whether `/api/docs` is served. Only ever NARROWS: production is hard-off in
  // `configuration.ts` regardless of this value, so setting it to `true` there
  // does nothing. It exists so a staging deployment with no reverse proxy in
  // front of it can hide the docs from the internet without a code change —
  // the Basic Auth that used to do that job lives in a Caddyfile, and a managed
  // container platform has no Caddyfile.
  SWAGGER_ENABLED: Joi.string()
    .valid('true', 'false')
    .allow('')
    .default('true'),

  // In production, refuse the wildcard origin — Same-Origin with
  // credentials: true is broken in browsers against `*`, and leaving the
  // wildcard in prod signals a CORS misconfiguration waiting to bite.
  CORS_ORIGIN: Joi.string()
    .default('*')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('*').required().messages({
        'any.invalid':
          'CORS_ORIGIN cannot be "*" in production — set an explicit origin list.',
      }),
    }),

  // Public web URL the API redirects to after a GET /auth/verify-email
  // click. The web app reads `?status=success|error&reason=…` and
  // renders the matching state. Optional in dev (defaults to
  // `${WEB_BASE_URL}/auth/verify-email`); production should set this
  // explicitly to the real landing page hostname.
  EMAIL_VERIFIED_REDIRECT_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/[^/]$/, { name: 'no-trailing-slash' })
    .optional(),

  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),

  // In production, require an explicit trust-proxy setting. "false" behind a
  // real load balancer collapses per-IP throttling into one global bucket;
  // "true" lets clients spoof X-Forwarded-For. Force the operator to decide.
  TRUST_PROXY: Joi.string()
    .default('false')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('false', 'true').required().messages({
        'any.invalid':
          'TRUST_PROXY must be set explicitly in production (e.g. "1" for a single proxy hop, or a CIDR list). "false" and "true" are both unsafe behind a load balancer.',
      }),
    })
    .description(
      'Express trust proxy setting. "false" = direct exposure (default), ' +
        '"true" = trust all (unsafe — allows X-Forwarded-For spoofing), ' +
        'a number = trust N hops, or a comma-separated list of IPs/CIDRs/' +
        'keywords (e.g. "loopback,10.0.0.0/8"). Set to "1" when running ' +
        'behind a single nginx/ALB hop.',
    ),
});
