import {
  accountPasswordMessage,
  checkedPasswordMessage,
  isAccountPassword,
  isWithinAccountPasswordBounds,
} from './account-password.util';

describe('isAccountPassword', () => {
  it.each(['abcdefg1', 'lysta2026', `${'a'.repeat(71)}1`])(
    'accepts %j',
    (value) => {
      expect(isAccountPassword(value)).toBe(true);
    },
  );

  it.each([
    ['too short', 'abcdef1'],
    ['too long', `${'a'.repeat(72)}1`],
    // 38 characters, 74 UTF-8 bytes: bcrypt would ignore the letter and digit
    // past byte 72, so the password it stores is weaker than the one checked.
    ['over 72 bytes in multi-byte characters', `${'ñ'.repeat(36)}a1`],
    ['no digit', 'abcdefgh'],
    ['no letter', '12345678'],
    ['not a string', 12345678],
    ['missing', undefined],
  ])('refuses a password that is %s', (_label, value) => {
    expect(isAccountPassword(value)).toBe(false);
  });
});

describe('isAccountPassword byte limit', () => {
  it('accepts a multi-byte password up to exactly 72 bytes', () => {
    // 35 × 2 bytes + 2 = 72 bytes.
    expect(isAccountPassword(`${'ñ'.repeat(35)}a1`)).toBe(true);
  });
});

describe('accountPasswordMessage', () => {
  it('names the field and the rule', () => {
    expect(accountPasswordMessage('newPassword')).toBe(
      'newPassword must be at least 8 characters and at most 72 bytes, and contain a letter and a digit',
    );
  });
});

describe('isWithinAccountPasswordBounds', () => {
  it.each([
    ['8 characters, no digit', 'abcdefgh', true],
    ['exactly 72 bytes', `${'ñ'.repeat(35)}a1`, true],
    ['over 72 bytes', `${'ñ'.repeat(36)}a1`, false],
    ['too short', 'abc1', false],
    ['not a string', 12345678, false],
  ])('%s → %s', (_label, value, expected) => {
    expect(isWithinAccountPasswordBounds(value)).toBe(expected);
  });

  it('names the field and the bounds', () => {
    expect(checkedPasswordMessage('currentPassword')).toBe(
      'currentPassword must be at least 8 characters and at most 72 bytes',
    );
  });
});
