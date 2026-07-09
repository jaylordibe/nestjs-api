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

  REDIS_HOST: Joi.string().hostname().required(),
  REDIS_PORT: Joi.number().port().required(),
  REDIS_PASSWORD: Joi.string().min(16).required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  JWT_SECRET: Joi.string()
    .min(32)
    .required()
    .invalid(
      // Reject the exact value that shipped in earlier versions of
      // .env.example so existing checkouts can't silently deploy with the
      // template default.
      '136542716fe8f487721f5e2a3b48574cc3282c086487f28600bda8057f37c92e96c58e64ebe347d29517a2862c6694e2',
    )
    .messages({
      'any.invalid':
        'JWT_SECRET is the template default — regenerate with `openssl rand -hex 48`.',
    }),
  JWT_EXPIRES_IN: Joi.string().default('30d'),

  // Backstop TTL for the per-user permission-grants cache in Redis. Role and
  // membership changes invalidate explicitly, so this only bounds the window
  // of a missed invalidation. Lower it if you distrust the invalidation paths;
  // raising it past a few minutes trades staleness for very little.
  AUTHORIZATION_GRANTS_CACHE_TTL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3600)
    .default(300),

  // Email provider selection. `stub` (default) logs to stdout — OTPs are
  // visible in the app log so local flows can be completed manually.
  // `resend` routes through resend.com and requires RESEND_API_KEY and
  // EMAIL_FROM (the latter must be a verified sender on that domain).
  EMAIL_PROVIDER: Joi.string().valid('stub', 'resend').default('stub'),
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
  SMS_PROVIDER: Joi.string().valid('stub', 'twilio').default('stub'),
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

  // File storage provider selection. `stub` (default) logs and returns
  // fake `stub://...` URLs — useful for local dev and tests where the
  // upload flow needs to exercise but no real persistence is wanted.
  // `s3` routes through AWS S3 (or any S3-compatible: Cloudflare R2,
  // DigitalOcean Spaces, MinIO) and requires STORAGE_S3_BUCKET +
  // STORAGE_S3_REGION + standard AWS credentials in the SDK chain
  // (env vars, shared config, or instance/task IAM roles).
  STORAGE_PROVIDER: Joi.string().valid('stub', 's3').default('stub'),
  STORAGE_S3_BUCKET: Joi.string().when('STORAGE_PROVIDER', {
    is: 's3',
    then: Joi.string().min(3).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  STORAGE_S3_REGION: Joi.string().when('STORAGE_PROVIDER', {
    is: 's3',
    then: Joi.string().required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  // Optional public URL base. Defaults to the standard
  // https://<bucket>.s3.<region>.amazonaws.com when unset. Set to your
  // CDN hostname (CloudFront, Cloudflare, R2 public bucket URL) when
  // fronting the bucket with a CDN.
  STORAGE_S3_PUBLIC_URL_BASE: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/[^/]$/, { name: 'no-trailing-slash' })
    .allow('')
    .optional(),
  // S3-compatible endpoint override. Set when using R2 / MinIO / Spaces;
  // leave empty for real AWS S3.
  STORAGE_S3_ENDPOINT: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  STORAGE_S3_FORCE_PATH_STYLE: Joi.string()
    .valid('true', 'false')
    .allow('')
    .default('false'),

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
