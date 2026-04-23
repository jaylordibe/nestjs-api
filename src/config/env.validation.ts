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

  CORS_ORIGIN: Joi.string().default('*'),

  THROTTLE_TTL_MS: Joi.number().integer().min(1000).default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(100),

  TRUST_PROXY: Joi.string()
    .default('false')
    .description(
      'Express trust proxy setting. "false" = direct exposure (default), ' +
        '"true" = trust all (unsafe — allows X-Forwarded-For spoofing), ' +
        'a number = trust N hops, or a comma-separated list of IPs/CIDRs/' +
        'keywords (e.g. "loopback,10.0.0.0/8"). Set to "1" when running ' +
        'behind a single nginx/ALB hop.',
    ),
});
