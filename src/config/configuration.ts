export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'staging' | 'production';
  serviceName: string;
  port: number;
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
  cors: {
    origin: string;
  };
  throttle: {
    ttlMs: number;
    limit: number;
  };
  trustProxy: boolean | number | string;
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
  cors: {
    origin: process.env.CORS_ORIGIN ?? '*',
  },
  throttle: {
    ttlMs: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY ?? 'false'),
});
