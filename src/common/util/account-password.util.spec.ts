import {
  accountPasswordMessage,
  isAccountPassword,
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
    ['no digit', 'abcdefgh'],
    ['no letter', '12345678'],
    ['not a string', 12345678],
    ['missing', undefined],
  ])('refuses a password that is %s', (_label, value) => {
    expect(isAccountPassword(value)).toBe(false);
  });
});

describe('accountPasswordMessage', () => {
  it('names the field and the rule', () => {
    expect(accountPasswordMessage('newPassword')).toBe(
      'newPassword must be 8–72 characters and contain a letter and a digit',
    );
  });
});
