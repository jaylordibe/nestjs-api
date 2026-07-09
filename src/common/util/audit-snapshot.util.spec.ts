import { buildAuditSnapshot } from './audit-snapshot.util';

describe('buildAuditSnapshot', () => {
  it('copies ordinary columns through', () => {
    expect(
      buildAuditSnapshot({ id: 'abc', name: 'Acme', isActive: true }),
    ).toEqual({ id: 'abc', name: 'Acme', isActive: true });
  });

  it('serializes dates as ISO strings', () => {
    const createdAt = new Date('2026-07-10T12:00:00.000Z');
    expect(buildAuditSnapshot({ createdAt })).toEqual({
      createdAt: '2026-07-10T12:00:00.000Z',
    });
  });

  it('preserves nulls (they are meaningful history)', () => {
    expect(buildAuditSnapshot({ deletedAt: null })).toEqual({
      deletedAt: null,
    });
  });

  it('omits undefined rather than storing a JSON null', () => {
    expect(buildAuditSnapshot({ id: 'a', missing: undefined })).toEqual({
      id: 'a',
    });
  });

  // The whole point of the denylist. The audit trail is readable by support and
  // developer roles, not just PLATFORM_ADMIN.
  it.each(['password', 'otpHash', 'otpPurpose', 'otpExpiresAt', 'token'])(
    'never snapshots `%s`',
    (column) => {
      const snapshot = buildAuditSnapshot({
        id: 'a',
        [column]: 'secret-value',
      });
      expect(snapshot).not.toHaveProperty(column);
      expect(JSON.stringify(snapshot)).not.toContain('secret-value');
    },
  );

  it('drops secrets entirely rather than masking them (no length leak)', () => {
    const snapshot = buildAuditSnapshot({
      email: 'user@example.com',
      password: '$2b$12$averylonghashvalue',
    });
    expect(snapshot).toEqual({ email: 'user@example.com' });
  });
});
