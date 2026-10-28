import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatStore } from './store.js';

describe('AI persistence', () => {
  it('defaults new channels to GLM 5.3 Flash without replacing saved selections', () => {
    const store = new ChatStore(':memory:');
    try {
      expect(store.load('new')).toMatchObject({
        model: 'glm-5.3-flash',
        imageModel: 'flux-1-schnell',
        summary: '',
        messages: [],
      });
      const existing = { ...store.load('existing'), model: 'glm-5.3' };
      store.save('existing', 'guild', existing);
      expect(store.load('existing').model).toBe('glm-5.3');
      store.clear('existing');
      expect(store.load('existing').model).toBe('glm-5.3');
      expect(store.load('another-new').model).toBe('glm-5.3-flash');
    } finally {
      store.close();
    }
  });

  it('isolates channels and persists history/models/reply provenance through restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'felicity-ai-'));
    let store = new ChatStore(join(dir, 'ai.sqlite'));
    try {
      const state = store.load('one');
      state.model = 'custom';
      state.imageModel = 'image';
      state.summary = 'old chat';
      state.messages = [{ role: 'user', content: 'hi' }];
      store.save('one', 'guild', state);
      store.markReply('one', 'reply');
      expect(store.load('two').messages).toEqual([]);
      expect(store.isReply('two', 'reply')).toBe(false);
      store.close();
      store = new ChatStore(join(dir, 'ai.sqlite'));
      expect(store.load('one')).toEqual(state);
      expect(store.isReply('one', 'reply')).toBe(true);
      store.clear('one');
      expect(store.load('one')).toMatchObject({
        model: 'custom',
        imageModel: 'image',
        summary: '',
        messages: [],
        observedTokens: 0,
      });
      expect(store.isReply('one', 'reply')).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('deletes channel/guild records without touching other channels or guilds', () => {
    const store = new ChatStore(':memory:');
    try {
      for (const [channel, guild] of [
        ['a', 'g1'],
        ['b', 'g1'],
        ['c', 'g2'],
      ]) {
        store.save(channel!, guild!, {
          ...store.load(channel!),
          summary: 'saved',
        });
        store.markReply(channel!, channel!);
      }
      store.removeChannel('a');
      expect(store.load('a').summary).toBe('');
      expect(store.isReply('a', 'a')).toBe(false);
      expect(store.load('b').summary).toBe('saved');
      store.removeGuild('g1');
      expect(store.load('b').summary).toBe('');
      expect(store.isReply('b', 'b')).toBe(false);
      expect(store.load('c').summary).toBe('saved');
    } finally {
      store.close();
    }
  });
});
