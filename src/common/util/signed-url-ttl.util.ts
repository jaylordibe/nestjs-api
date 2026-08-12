// Bounds on how long a signed object-storage URL may live.
//
// A signed URL is a bearer credential with no revocation: once minted, anyone
// holding the string can read the object until it expires, and nothing the
// application does afterwards — logging the user out, revoking their role,
// deleting their session — takes it back. The lifetime IS the entire security
// boundary, so it is clamped centrally rather than trusted to each call site.
//
// The ceiling is deliberately low. A URL long enough to be pasted into a chat,
// indexed by a proxy, or kept in a browser history for a week is a permission
// grant nobody recorded. Anything needing durable access should re-request a
// fresh URL, which re-runs the authorization check that produced the first one.
export const MINIMUM_SIGNED_URL_TTL_SECONDS = 30;
export const MAXIMUM_SIGNED_URL_TTL_SECONDS = 3600;

// Clamps rather than throws. A call site asking for an over-long URL gets a
// shorter one and still works; throwing would turn a bounds mistake into a
// failed download, which is a worse outcome for the same defect. A non-finite
// or non-positive request falls back to the configured default, since it
// carries no usable intent.
export function resolveSignedUrlTtlSeconds(
  requestedTtlSeconds: number | undefined,
  defaultTtlSeconds: number,
): number {
  const candidateTtlSeconds =
    requestedTtlSeconds !== undefined &&
    Number.isFinite(requestedTtlSeconds) &&
    requestedTtlSeconds > 0
      ? requestedTtlSeconds
      : defaultTtlSeconds;

  return Math.min(
    Math.max(Math.floor(candidateTtlSeconds), MINIMUM_SIGNED_URL_TTL_SECONDS),
    MAXIMUM_SIGNED_URL_TTL_SECONDS,
  );
}
