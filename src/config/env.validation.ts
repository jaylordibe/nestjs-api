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
  APP_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .pattern(/[^/]$/, { name: 'no-trailing-slash' })
    .default('http://localhost:3000/api'),

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

  // Email provider selection. `stub` (default) logs to stdout — OTPs are
  // visible in the app log so local flows can be completed manually.
  // `resend` routes through resend.com and requires RESEND_API_KEY and
  // EMAIL_FROM (the latter must be a verified sender on that domain).
  EMAIL_PROVIDER: Joi.string().valid('stub', 'resend').default('stub'),
  EMAIL_FROM: Joi.string().when('EMAIL_PROVIDER', {
    is: 'resend',
    then: Joi.required(),
  }),
  RESEND_API_KEY: Joi.string().when('EMAIL_PROVIDER', {
    is: 'resend',
    then: Joi.required(),
  }),

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
