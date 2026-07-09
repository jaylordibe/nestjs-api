import { toSnakeCase } from './string-case.util';

describe('toSnakeCase', () => {
  it.each([
    ['all', 'all'],
    ['User', 'user'],
    ['Business', 'business'],
    ['BusinessMember', 'business_member'],
    ['AppVersion', 'app_version'],
    ['DeviceToken', 'device_token'],
    ['AuditLog', 'audit_log'],
    ['assignRole', 'assign_role'],
    ['manage', 'manage'],
    ['read', 'read'],
  ])('converts %s → %s', (input, expected) => {
    expect(toSnakeCase(input)).toBe(expected);
  });

  it('collapses an acronym run into a single segment', () => {
    expect(toSnakeCase('deviceOSVersion')).toBe('device_os_version');
  });

  it('is idempotent on already-snake input', () => {
    expect(toSnakeCase('business_member')).toBe('business_member');
  });
});
