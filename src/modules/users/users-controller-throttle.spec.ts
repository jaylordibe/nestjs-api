import { UsersController } from './users.controller';

// The e2e suite runs with throttling skipped (`skipIf: isTest` in AppModule),
// so per-route limits are pinned here instead. The key is @nestjs/throttler's
// own metadata name; if the library renames it, these read `undefined` and
// fail loudly rather than pass.
const THROTTLER_LIMIT_KEY = 'THROTTLER:LIMITdefault';

function limitOf(handlerName: keyof UsersController): unknown {
  const handler = Object.getOwnPropertyDescriptor(
    UsersController.prototype,
    handlerName,
  )?.value as object;
  return Reflect.getMetadata(THROTTLER_LIMIT_KEY, handler) as unknown;
}

describe('UsersController throttles', () => {
  it.each([
    'updateAuthUserPassword',
    'updateAuthUserEmail',
    'gdprErase',
  ] as const)(
    '%s checks currentPassword and allows 5 attempts a minute',
    (handlerName) => {
      expect(limitOf(handlerName)).toBe(5);
    },
  );

  // Each replace releases the old picture, which the cleanup job then deletes
  // from storage: the same ceiling as the upload that precedes it.
  it.each(['setAuthUserProfileImage', 'removeAuthUserProfileImage'] as const)(
    '%s allows 30 calls a minute, like POST /files',
    (handlerName) => {
      expect(limitOf(handlerName)).toBe(30);
    },
  );

  it.each(['create', 'updatePassword'] as const)(
    '%s hashes a password and allows 20 calls a minute',
    (handlerName) => {
      expect(limitOf(handlerName)).toBe(20);
    },
  );
});
