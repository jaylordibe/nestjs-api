// Defaults for the `FILE_*` variables, shared by the Joi schema
// (`env.validation.ts`) and the typed config (`configuration.ts`) so the two
// cannot disagree. Each is the value used when the variable is unset.
export const FILE_UPLOAD_DEFAULTS = {
  // The largest purpose limit (`document`, 25 MiB): a higher ceiling would
  // only let a body be buffered before it is refused.
  maxUploadBytes: 25 * 1024 * 1024,
  uploadTtlSeconds: 24 * 60 * 60,
  imageMaxPixels: 40_000_000,
} as const;
