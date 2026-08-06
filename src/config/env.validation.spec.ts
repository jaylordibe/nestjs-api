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
