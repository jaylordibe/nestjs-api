import { EmailTemplateEngine } from './template-engine';

// Every declared template must exist on disk and render. The e2e harness
// replaces sendTemplate, so without this a missing or renamed .hbs file would
// pass every test and fail on the first real send.
describe('EmailTemplateEngine', () => {
  const engine = new EmailTemplateEngine();

  beforeAll(() => {
    engine.onModuleInit();
  });

  it.each([
    [
      'email-verification-link',
      { verifyUrl: 'https://example.test/v', firstName: 'Ada' },
    ],
    [
      'password-reset-link',
      {
        firstName: 'Ada',
        resetUrl: 'https://example.test/r',
        expiresInMinutes: 60,
      },
    ],
    [
      'password-changed-notification',
      { firstName: 'Ada', occurredAt: '2026-01-01T00:00:00.000Z' },
    ],
    [
      'email-changed-notification',
      { firstName: 'Ada', occurredAt: '2026-01-01T00:00:00.000Z' },
    ],
    [
      'workspace-invitation',
      {
        workspaceName: 'Acme',
        inviterName: 'Ada',
        roleName: 'Member',
        acceptUrl: 'https://example.test/a',
        expiresInDays: 7,
      },
    ],
  ] as const)('renders %s', (key, vars) => {
    const rendered = engine.render(key, vars);

    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html).toContain('Ada');
    expect(rendered.text.length).toBeGreaterThan(0);
  });
});
