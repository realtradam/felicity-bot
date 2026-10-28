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

it('enables optional notifications only with an existing key and supports explicit disabling', () => {
  expect(loadConfig(valid).openaiReset.enabled).toBe(false);
  expect(
    loadConfig({ ...valid, VERCEL_TOKEN: 'legacy-test-key' }).openaiReset,
  ).toEqual({ enabled: true, apiKey: 'legacy-test-key' });
  expect(
    loadConfig({
      ...valid,
      AI_GATEWAY_API_KEY: 'preferred-test-key',
      VERCEL_TOKEN: 'legacy-test-key',
    }).openaiReset.apiKey,
  ).toBe('preferred-test-key');
  expect(
    loadConfig({ ...valid, AI_GATEWAY_API_KEY: ' ', VERCEL_TOKEN: '' })
      .openaiReset.enabled,
  ).toBe(false);
  expect(
    loadConfig({
      ...valid,
      VERCEL_TOKEN: 'legacy-test-key',
      OPENAI_RESET_ENABLED: 'false',
    }).openaiReset.enabled,
  ).toBe(false);
  expect(() =>
    loadConfig({
      ...valid,
      OPENAI_RESET_ENABLED: 'yes',
      AI_GATEWAY_API_KEY: 'never-print-gateway-key',
    }),
  ).toThrow('Missing or invalid configuration: OPENAI_RESET_ENABLED');
});

it('enables Logfare chat only with a key, supports disabling, and never exposes keys in validation errors', () => {
  expect(loadConfig(valid).ai).toBeUndefined();
  expect(loadConfig({ ...valid, LOGFARE_API_KEY: 'test-key' }).ai).toEqual({
    apiKey: 'test-key',
    searchApiKey: undefined,
  });
  expect(loadConfig({ ...valid, LOGFARE_API_KEY: '  ' }).ai).toBeUndefined();
  expect(
    loadConfig({
      ...valid,
      LOGFARE_API_KEY: 'test-key',
      AI_CHAT_ENABLED: 'false',
    }).ai,
  ).toBeUndefined();
  expect(() =>
    loadConfig({
      ...valid,
      LOGFARE_API_KEY: 'never-print-me',
      AI_CHAT_ENABLED: 'yes',
    }),
  ).toThrow('Missing or invalid configuration: AI_CHAT_ENABLED');
});

it('uses the Umans key only for optional Exa search, never as the chat credential', () => {
  expect(
    loadConfig({ ...valid, UMANS_API_KEY: 'search-test-key' }).ai,
  ).toBeUndefined();
  expect(
    loadConfig({
      ...valid,
      LOGFARE_API_KEY: 'chat-test-key',
      UMANS_API_KEY: 'search-test-key',
    }).ai,
  ).toEqual({ apiKey: 'chat-test-key', searchApiKey: 'search-test-key' });
  expect(
    loadConfig({
      ...valid,
      LOGFARE_API_KEY: 'chat-test-key',
      UMANS_API_KEY: '  ',
    }).ai?.searchApiKey,
  ).toBeUndefined();
});
