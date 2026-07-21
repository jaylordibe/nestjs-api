import * as bcrypt from 'bcrypt';
import {
  BCRYPT_ROUNDS,
  burnPasswordHashingTime,
  hashPassword,
} from './password-hashing.util';

describe('password-hashing util', () => {
  // bcrypt at 12 rounds costs ~250ms per call, so this suite deliberately
  // hashes as few times as possible.
  jest.setTimeout(15000);

  it('hashes at the shared cost factor, encoded in the hash prefix', async () => {
    const hash = await hashPassword('Str0ngPassw0rd');
    // `$2b$12$…` — the cost travels with the hash, which is what lets
    // BCRYPT_ROUNDS be raised later without invalidating stored passwords.
    expect(hash.startsWith(`$2b$${BCRYPT_ROUNDS}$`)).toBe(true);
    await expect(bcrypt.compare('Str0ngPassw0rd', hash)).resolves.toBe(true);
  });

  it('salts, so the same password never yields the same hash twice', async () => {
    const [first, second] = await Promise.all([
      hashPassword('Str0ngPassw0rd'),
      hashPassword('Str0ngPassw0rd'),
    ]);
    expect(first).not.toBe(second);
  });

  it('burns hashing time without returning anything to leak', async () => {
    await expect(
      burnPasswordHashingTime('Str0ngPassw0rd'),
    ).resolves.toBeUndefined();
  });
});
