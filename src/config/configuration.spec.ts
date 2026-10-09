import { isEnvFileIgnored } from './configuration';

describe('isEnvFileIgnored', () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('skips `.env` under test, so a developer’s file never fills `.env.test`', () => {
    process.env.NODE_ENV = 'test';
    expect(isEnvFileIgnored()).toBe(true);
  });

  it.each(['development', 'staging', 'production'])(
    'reads `.env` under %s',
    (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;
      expect(isEnvFileIgnored()).toBe(false);
    },
  );

  it('reads `.env` when NODE_ENV is unset, as `yarn start:dev` runs', () => {
    delete process.env.NODE_ENV;
    expect(isEnvFileIgnored()).toBe(false);
  });
});
