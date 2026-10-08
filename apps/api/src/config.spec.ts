import { resolveJwtSecret } from './config.js';

describe('resolveJwtSecret', () => {
  const strong = 'a'.repeat(64);

  it('falls back to a dev secret outside production', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'development' })).toBeTruthy();
    expect(resolveJwtSecret({ NODE_ENV: 'test', JWT_SECRET: '' })).toBeTruthy();
    expect(resolveJwtSecret({ NODE_ENV: 'development', JWT_SECRET: 'mine' })).toBe('mine');
  });

  it('requires a real secret in production', () => {
    expect(() => resolveJwtSecret({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: '  ' })).toThrow(/JWT_SECRET/);
    expect(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
  });

  it('rejects secrets published in this repo', () => {
    for (const known of ['dev-only-insecure-secret', 'change-me-in-production', 'local-docker-secret-change-me']) {
      expect(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: known })).toThrow(/JWT_SECRET/);
    }
    expect(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: ` ${strong} ` })).toBe(strong);
  });
});
