import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envValidationSchema } from './env.validation';

// A required key that nobody wrote down is a production outage with a
// misleading symptom. Joi validates during module initialisation, so the
// container exits before it ever listens — the deploy's healthcheck and smoke
// test do catch it, but they catch it in production, after the migration has
// already been applied and the old container has already been stopped.
//
// `.env.example` is the only artifact an operator reads when provisioning an
// environment, so "the schema requires it" and "the example documents it" have
// to be the same set. This spec keeps them the same set; it costs milliseconds
// inside `yarn test`, which already runs in CI, so it needs no workflow wiring.
const ENVIRONMENT_EXAMPLE_PATH = join(__dirname, '..', '..', '.env.example');

// Every environment the schema can tighten for. `production` and `staging` are
// the ones carrying `.when(...)` branches today; listing `development` and
// `test` too means a future branch on either is covered the day it is written
// rather than the day it breaks.
const VALIDATED_ENVIRONMENTS = [
  'production',
  'staging',
  'development',
  'test',
] as const;

// Matches `KEY=`, with or without a leading `#`. Commented-out keys count as
// documented on purpose: an operator reading the file still learns the key
// exists and what it is for, which is the point. Demanding they be uncommented
// would push real secrets into an example file.
const DOCUMENTED_KEY_PATTERN = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/;

export function parseDocumentedEnvironmentKeys(
  exampleContent: string,
): Set<string> {
  const documentedKeys = new Set<string>();

  for (const line of exampleContent.split('\n')) {
    const match = DOCUMENTED_KEY_PATTERN.exec(line);
    if (match) {
      documentedKeys.add(match[1]);
    }
  }

  return documentedKeys;
}

export function findUndocumentedRequiredKeys(
  requiredKeys: readonly string[],
  documentedKeys: ReadonlySet<string>,
): string[] {
  return requiredKeys.filter((key) => !documentedKeys.has(key)).sort();
}

// Ask Joi what it demands instead of walking `describe()` internals. Validating
// an otherwise-empty environment surfaces every `any.required` at once
// (`abortEarly: false`), including conditional requirements that activate only
// for a given NODE_ENV — precisely the class a hand-maintained list would miss.
function environmentKeysRequiredFor(nodeEnvironment: string): string[] {
  const { error } = envValidationSchema.validate(
    { NODE_ENV: nodeEnvironment },
    { abortEarly: false, allowUnknown: true },
  );

  return (error?.details ?? [])
    .filter((detail) => detail.type === 'any.required')
    .map((detail) => String(detail.path[0]))
    .sort();
}

// The detection logic is proved against fixtures rather than by mutating the
// real `.env.example`. A guardrail whose failing case is never exercised is
// indistinguishable from one that cannot fail.
describe('findUndocumentedRequiredKeys', () => {
  const documented = parseDocumentedEnvironmentKeys(
    ['SERVICE_NAME=example', '# JWT_SECRET=change-me', 'PORT=3000'].join('\n'),
  );

  it('passes when every required key is documented', () => {
    expect(
      findUndocumentedRequiredKeys(['SERVICE_NAME', 'PORT'], documented),
    ).toEqual([]);
  });

  it('counts a commented-out key as documented', () => {
    expect(findUndocumentedRequiredKeys(['JWT_SECRET'], documented)).toEqual(
      [],
    );
  });

  it('catches a required key that was never written down', () => {
    expect(
      findUndocumentedRequiredKeys(['SERVICE_NAME', 'REDIS_URL'], documented),
    ).toEqual(['REDIS_URL']);
  });

  it('catches a key documented under a different name', () => {
    const aliased = parseDocumentedEnvironmentKeys('SERVICE_NAMES=example');
    expect(findUndocumentedRequiredKeys(['SERVICE_NAME'], aliased)).toEqual([
      'SERVICE_NAME',
    ]);
  });

  it('ignores lines that are prose rather than assignments', () => {
    const prose = parseDocumentedEnvironmentKeys(
      '# See README for SERVICE_NAME',
    );
    expect(prose.size).toBe(0);
  });
});

describe('env.validation ↔ .env.example parity', () => {
  const documentedKeys = parseDocumentedEnvironmentKeys(
    readFileSync(ENVIRONMENT_EXAMPLE_PATH, 'utf8'),
  );

  it('parses keys out of the real .env.example', () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    expect(documentedKeys.size).toBeGreaterThan(10);
  });

  it.each(VALIDATED_ENVIRONMENTS)(
    'documents every key required in %s',
    (nodeEnvironment) => {
      const undocumentedKeys = findUndocumentedRequiredKeys(
        environmentKeysRequiredFor(nodeEnvironment),
        documentedKeys,
      );

      expect({ nodeEnvironment, undocumentedKeys }).toEqual({
        nodeEnvironment,
        undocumentedKeys: [],
      });
    },
  );
});

// A configuration that is individually valid but collectively wrong is the
// class this block exists for. Each combination below boots successfully and
// then behaves incorrectly in a way no log line reports, so the only place to
// catch it is at validation.
describe('env.validation cross-field rules', () => {
  // Enough to get past the unconditional `required()` keys so a test can
  // isolate the rule it is actually about.
  const VALID_BASE_ENVIRONMENT = {
    NODE_ENV: 'development',
    SERVICE_NAME: 'nestjs',
    DB_USER: 'nestjs',
    DB_PASSWORD: 'password',
    DB_HOST: 'localhost',
    DB_PORT: 5433,
    DB_NAME: 'nestjs_local',
    DATABASE_URL: 'postgresql://nestjs:password@localhost:5433/nestjs_local',
    REDIS_HOST: 'localhost',
    REDIS_PORT: 6378,
    REDIS_PASSWORD: 'a-redis-password-long-enough',
    REDIS_URL: 'redis://default:a-redis-password-long-enough@localhost:6378',
    JWT_SECRET: 'a'.repeat(48),
  };

  function validate(overrides: Record<string, unknown>) {
    return envValidationSchema.validate(
      { ...VALID_BASE_ENVIRONMENT, ...overrides },
      { abortEarly: false, allowUnknown: true },
    );
  }

  it('accepts the baseline development environment', () => {
    expect(validate({}).error).toBeUndefined();
  });

  describe('Redis TLS', () => {
    // The silent failure: an operator sets the flag, believes the connection is
    // encrypted, and it is plaintext because the URL still says redis://.
    it('rejects TLS enabled against a plaintext redis:// URL', () => {
      expect(validate({ REDIS_TLS_ENABLED: 'true' }).error?.message).toContain(
        'must use the rediss:// scheme',
      );
    });

    // The mirror image: TLS options (CA, verification) are never applied
    // because nothing turned them on.
    it('rejects a rediss:// URL with TLS left off', () => {
      expect(
        validate({ REDIS_URL: 'rediss://default:pw@10.0.0.3:6378' }).error
          ?.message,
      ).toContain('REDIS_TLS_ENABLED is not true');
    });

    it('accepts TLS enabled with a rediss:// URL', () => {
      expect(
        validate({
          REDIS_TLS_ENABLED: 'true',
          REDIS_URL: 'rediss://default:pw@10.0.0.3:6378',
        }).error,
      ).toBeUndefined();
    });

    // A CA is optional even with TLS on — a publicly-trusted certificate needs
    // no private trust anchor.
    it('accepts TLS without a CA', () => {
      expect(
        validate({
          REDIS_TLS_ENABLED: 'true',
          REDIS_URL: 'rediss://10.0.0.3:6378',
          REDIS_TLS_CA: '',
        }).error,
      ).toBeUndefined();
    });

    it('rejects a CA supplied with TLS disabled', () => {
      expect(
        validate({ REDIS_TLS_CA: '-----BEGIN CERTIFICATE-----' }).error
          ?.message,
      ).toContain('the connection would be plaintext');
    });
  });

  // No provider is privileged, and selecting one must never force another's
  // configuration to exist. That is what keeps the same image deployable to a
  // different cloud with only environment changes.
  describe('object storage', () => {
    // The stub is the default precisely so a fresh clone needs nothing granted.
    it('requires no storage configuration on the stub provider', () => {
      expect(validate({ STORAGE_PROVIDER: 'stub' }).error).toBeUndefined();
    });

    it('defaults to the stub provider', () => {
      const { value } = validate({}) as { value: Record<string, unknown> };

      expect(value.STORAGE_PROVIDER).toBe('stub');
    });

    it.each([
      ['s3', { STORAGE_S3_BUCKET: 'uploads' }, ['STORAGE_S3_BUCKET']],
      ['gcs', { STORAGE_GCS_BUCKET: 'uploads' }, ['STORAGE_GCS_BUCKET']],
      [
        'azure',
        {
          STORAGE_AZURE_ACCOUNT_NAME: 'examplestorage',
          STORAGE_AZURE_CONTAINER: 'uploads',
        },
        ['STORAGE_AZURE_ACCOUNT_NAME', 'STORAGE_AZURE_CONTAINER'],
      ],
    ])(
      'validates only %s fields when %s is selected',
      (provider, completeConfiguration, expectedRequiredKeys) => {
        const missing = validate({ STORAGE_PROVIDER: provider });
        expect(
          (missing.error?.details ?? [])
            .map((detail) => String(detail.path[0]))
            .sort(),
        ).toEqual([...expectedRequiredKeys].sort());

        expect(
          validate({ STORAGE_PROVIDER: provider, ...completeConfiguration })
            .error,
        ).toBeUndefined();
      },
    );

    // Region is deliberately optional even for s3 — an instance profile, the
    // shared config file and AWS_REGION all already answer it, and requiring it
    // would break the hosts that do.
    it('does not require an S3 region', () => {
      expect(
        validate({ STORAGE_PROVIDER: 's3', STORAGE_S3_BUCKET: 'uploads' })
          .error,
      ).toBeUndefined();
    });

    // The whole point of the keyless design: there is nowhere to put a
    // long-lived cloud credential, so nobody is tempted to.
    it('declares no credential variable for any provider', () => {
      const declaredKeys = Object.keys(
        envValidationSchema.describe().keys as Record<string, unknown>,
      );

      expect(
        declaredKeys.filter((key) =>
          /ACCESS_KEY|SECRET_KEY|ACCOUNT_KEY|CONNECTION_STRING|CREDENTIALS|SERVICE_ACCOUNT|PRIVATE_KEY/.test(
            key,
          ),
        ),
      ).toEqual([]);
    });

    it('rejects a provider this release has no adapter for', () => {
      expect(
        validate({ STORAGE_PROVIDER: 'dropbox' }).error?.message,
      ).toContain('STORAGE_PROVIDER');
    });

    // A signed URL cannot be revoked, so an operator must not be able to
    // configure a day-long default.
    it('bounds the signed-URL lifetime', () => {
      expect(
        validate({ STORAGE_SIGNED_URL_TTL_SECONDS: 86_400 }).error?.message,
      ).toContain('STORAGE_SIGNED_URL_TTL_SECONDS');

      const { value } = validate({}) as { value: Record<string, unknown> };
      expect(value.STORAGE_SIGNED_URL_TTL_SECONDS).toBe(300);
    });

    // Objects are private unless an operator explicitly says otherwise.
    it('leaves the public URL base unset by default', () => {
      const { value } = validate({}) as { value: Record<string, unknown> };

      expect(value.STORAGE_PUBLIC_URL_BASE).toBeUndefined();
    });
  });

  describe('Postgres pool', () => {
    // Defaults exist so a fresh clone boots, but they must be REAL numbers the
    // capacity arithmetic can be done against rather than library defaults
    // nobody chose.
    it('defaults every pool setting to an explicit value', () => {
      const { value } = validate({}) as {
        value: Record<string, unknown>;
      };

      expect(value.DATABASE_POOL_MAX).toBe(10);
      expect(value.DATABASE_CONNECTION_TIMEOUT_MS).toBe(5_000);
      expect(value.DATABASE_IDLE_TIMEOUT_MS).toBe(30_000);
    });

    it('rejects a pool size a single process has no business holding', () => {
      expect(validate({ DATABASE_POOL_MAX: 500 }).error?.message).toContain(
        'DATABASE_POOL_MAX',
      );
    });

    // An unbounded connection wait outlives the request that is waiting, which
    // means an instance held open past its own request deadline.
    it('rejects an unbounded connection timeout', () => {
      expect(
        validate({ DATABASE_CONNECTION_TIMEOUT_MS: 0 }).error?.message,
      ).toContain('DATABASE_CONNECTION_TIMEOUT_MS');
    });
  });

  describe('queue worker runtime', () => {
    // The one variable that separates the API runtime from the worker runtime.
    // It defaults to true so a single local process does everything; both
    // deployed runtimes set it explicitly.
    it('defaults the worker to enabled for a single-process local run', () => {
      const { value } = validate({}) as { value: Record<string, unknown> };

      expect(value.QUEUE_WORKER_ENABLED).toBe(true);
    });

    it('accepts the API runtime contract', () => {
      const { error, value } = validate({ QUEUE_WORKER_ENABLED: 'false' }) as {
        error?: Error;
        value: Record<string, unknown>;
      };

      expect(error).toBeUndefined();
      expect(value.QUEUE_WORKER_ENABLED).toBe(false);
    });
  });
});
