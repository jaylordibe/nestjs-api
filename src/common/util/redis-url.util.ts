// Redis connection URL → discrete ioredis connection options.
//
// Why this exists rather than reading `redis.host` / `redis.port` from config:
// the LOGICAL DATABASE INDEX only ever appears in `REDIS_URL`'s path segment
// (`redis://…:6379/3`), never in the discrete `REDIS_HOST`/`REDIS_PORT` vars.
// The e2e harness gives every jest worker its own logical database by rewriting
// exactly that path segment (`test/setup/worker-isolation.ts`), so anything
// building a connection from the discrete vars silently lands on database 0 and
// every parallel worker shares one Redis namespace. BullMQ builds its
// connections from options rather than a URL string, so the URL has to be
// parsed here — this function is the seam that keeps queue state isolated per
// worker.
export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  // Logical database index (`SELECT n`). Redis ships 16 by default; 0 when the
  // URL carries no path segment.
  db: number;
  // ioredis enables TLS only when this key is present, so it stays undefined
  // for plain `redis://` rather than being set to `false`.
  tls?: Record<string, never>;
}

const DEFAULT_REDIS_PORT = 6379;
const DEFAULT_REDIS_DATABASE_INDEX = 0;

export function parseRedisConnectionOptions(
  url: string,
): RedisConnectionOptions {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid Redis URL: ${redactRedisUrl(url)}`);
  }

  if (parsedUrl.protocol !== 'redis:' && parsedUrl.protocol !== 'rediss:') {
    throw new Error(
      `Invalid Redis URL scheme "${parsedUrl.protocol}" — expected redis: or rediss:`,
    );
  }

  const databaseSegment = parsedUrl.pathname.replace(/^\//, '');
  if (databaseSegment.length > 0 && !/^\d+$/.test(databaseSegment)) {
    // The offending segment is deliberately NOT echoed. `redis:` is a
    // non-special scheme, so a malformed URL (`redis:/default:secret@host`)
    // parses "successfully" with the whole credential sitting in the path —
    // echoing it would print the Redis password into the boot logs.
    throw new Error(
      `Invalid Redis logical database index in URL: ${redactRedisUrl(url)} — expected a non-negative integer path segment`,
    );
  }

  // WHATWG URL percent-encodes credentials, so a password containing `@` or `/`
  // round-trips correctly only after decoding.
  //
  // Wrapped because WHATWG does NOT re-encode a `%` that was already in the
  // userinfo: a password like `pa%ss` reaches decodeURIComponent as-is and
  // throws a bare `URIError: URI malformed` that names neither REDIS_URL nor
  // this function — a baffling boot failure for a perfectly ordinary generated
  // secret.
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsedUrl.username);
    password = decodeURIComponent(parsedUrl.password);
  } catch {
    throw new Error(
      `Invalid percent-encoding in the credentials of Redis URL: ${redactRedisUrl(url)}. Percent-encode a literal "%" as "%25".`,
    );
  }

  return {
    host: parsedUrl.hostname,
    port:
      parsedUrl.port.length > 0
        ? Number.parseInt(parsedUrl.port, 10)
        : DEFAULT_REDIS_PORT,
    ...(username.length > 0 ? { username } : {}),
    ...(password.length > 0 ? { password } : {}),
    db:
      databaseSegment.length > 0
        ? Number.parseInt(databaseSegment, 10)
        : DEFAULT_REDIS_DATABASE_INDEX,
    ...(parsedUrl.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

// Everything between the scheme and the first `@` — i.e. the whole userinfo
// segment. Matches `redis://user:pass@…` and also the slash-starved
// `redis:/user:pass@…` a typo produces, because `redis:` is a non-special
// scheme and WHATWG parses that shape without complaint.
const REDIS_URL_CREDENTIAL_PATTERN = /^([a-z][a-z0-9+.-]*:\/{0,2})[^@]*@/i;

// Strips credentials so a malformed-URL error can be logged without leaking the
// Redis password into logs or an exception message.
export function redactRedisUrl(url: string): string {
  return url.replace(REDIS_URL_CREDENTIAL_PATTERN, '$1***@');
}
