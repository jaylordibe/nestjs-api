export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  serviceName: string;
  port: number;
  appBaseUrl: string;
  // Customer-facing web frontend base URL. Distinct from `appBaseUrl`
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
  };
  redis: {
    host: string;
    port: number;
    password: string;
    url: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
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
    provider: 'stub' | 's3';
    s3: {
      bucket: string | undefined;
      region: string | undefined;
      // Optional public URL prefix. Defaults to
      // https://<bucket>.s3.<region>.amazonaws.com when unset. Override
      // when fronting the bucket with CloudFront / Cloudflare / R2 under
      // a custom hostname so the URLs returned go through the CDN.
      publicUrlBase: string | undefined;
      // S3-compatible endpoint (Cloudflare R2, MinIO, DigitalOcean
      // Spaces). Leave unset for real AWS S3.
      endpoint: string | undefined;
      // Path-style addressing (`https://endpoint/bucket/key`). Required
      // by some S3-compatible servers (older MinIO setups).
      forcePathStyle: boolean;
    };
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
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000/api',
  webBaseUrl: process.env.WEB_BASE_URL ?? 'http://localhost:5173',
  gitSha: process.env.GIT_SHA ?? 'unknown',
  database: {
    url: process.env.DATABASE_URL!,
    name: process.env.DB_NAME!,
  },
  redis: {
    host: process.env.REDIS_HOST!,
    port: parseInt(process.env.REDIS_PORT!, 10),
    password: process.env.REDIS_PASSWORD!,
    url: process.env.REDIS_URL!,
  },
  jwt: {
    secret: process.env.JWT_SECRET!,
    expiresIn: process.env.JWT_EXPIRES_IN ?? '30d',
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
    provider: (process.env.STORAGE_PROVIDER as 'stub' | 's3') ?? 'stub',
    s3: {
      bucket: process.env.STORAGE_S3_BUCKET || undefined,
      region: process.env.STORAGE_S3_REGION || undefined,
      publicUrlBase: process.env.STORAGE_S3_PUBLIC_URL_BASE || undefined,
      endpoint: process.env.STORAGE_S3_ENDPOINT || undefined,
      forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true',
    },
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
