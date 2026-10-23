import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
  DISCORD_TOKEN: 'a-secret-for-tests-only',
  DISCORD_CLIENT_ID: '123456789012345678',
};

describe('configuration', () => {
  it('requires credentials', () => {
    expect(() => loadConfig({})).toThrow('DISCORD_TOKEN');
  });
  it('provides defaults', () => {
    expect(loadConfig(valid).logLevel).toBe('info');
    expect(loadConfig(valid).dataDir).toMatch(/data$/);
  });
  it('never includes secrets in validation errors', () => {
    expect(() =>
      loadConfig({ ...valid, DISCORD_CLIENT_ID: 'invalid' }),
    ).toThrow('Missing or invalid configuration: DISCORD_CLIENT_ID');
  });
});

it('defaults to a bounded preview cache and rejects invalid sizes', () => {
  expect(loadConfig(valid).previewCacheSize).toBe(100);
  expect(
    loadConfig({ ...valid, PREVIEW_CACHE_SIZE: '20' }).previewCacheSize,
  ).toBe(20);
  for (const size of ['0', '9', '2001', '1.5', 'invalid']) {
    expect(() => loadConfig({ ...valid, PREVIEW_CACHE_SIZE: size })).toThrow(
      'PREVIEW_CACHE_SIZE',
    );
  }
});
