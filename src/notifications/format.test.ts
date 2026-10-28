import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORY_QUESTION } from './prompt.js';
import { formatNotification, sampleNotification } from './format.js';
import type { Tweet } from './types.js';

const post: Tweet = {
  id: '2115273253711409208',
  text: 'Limits reset today.',
  createdAt: 123,
  context: [],
};

describe('notification output', () => {
  it('shows the actual chosen category probability, never a hardcoded confidence', () => {
    expect(
      formatNotification(post, { category: 'reset', confidence: 0.632 }),
    ).toContain('AI confidence: **63.2%** (model estimate)');
    expect(
      formatNotification(post, { category: 'feature', confidence: 0.819 }),
    ).toContain('OpenAI feature update');
    expect(
      formatNotification(post, { category: 'feature', confidence: 0.819 }),
    ).toContain('**81.9%**');
    expect(
      formatNotification(post, { category: 'reset', confidence: 0.632 }),
    ).toContain('<https://x.com/thsottiaux/status/2115273253711409208>');
  });
  it('keeps adversarially long text/newlines/context under Discord limits and escapes markdown', () => {
    for (const text of [
      'x'.repeat(16000),
      '\n'.repeat(16000),
      '**fake alert** <@123> ' + 'a\n'.repeat(8000),
    ]) {
      const output = formatNotification(
        {
          ...post,
          text,
          context: [
            { relation: 'quote', depth: 1, is_monitored_author: false, text },
          ],
        },
        { category: 'reset', confidence: 0.9 },
      );
      expect(output.length).toBeLessThanOrEqual(2000);
      expect(output).not.toContain('<@123>');
      expect(output).toContain('https://x.com/thsottiaux/status/');
    }
    expect(
      formatNotification(
        { ...post, text: '**not a header**' },
        { category: 'reset', confidence: 0.9 },
      ),
    ).toContain('\\*\\*not a header\\*\\*');
  });
  it('does not use an untrusted URL as the source link and rejects invalid probabilities', () => {
    expect(() =>
      formatNotification(
        { ...post, id: 'https://untrusted.example/' },
        { category: 'reset', confidence: 0.5 },
      ),
    ).toThrow('Invalid source post ID');
    for (const confidence of [NaN, Infinity, -0.1, 1.1])
      expect(() =>
        formatNotification(post, { category: 'feature', confidence }),
      ).toThrow('Invalid notification confidence');
    expect(() =>
      formatNotification(post, { category: 'neither', confidence: 0.9 }),
    ).toThrow('Unrelated');
  });
  it('labels synthetic content/confidence clearly and contains no invented source tweet URL', () => {
    const output = sampleNotification();
    expect(output).toContain('SAMPLE');
    expect(output).toContain('97.4%');
    expect(output).toContain('example value; no AI call');
    expect(output).toContain('not a real announcement');
    expect(output).not.toContain('/status/');
  });
  it('keeps the runtime prompt identical to the frozen, evaluated research prompt', () => {
    const frozen = JSON.parse(
      readFileSync(
        new URL(
          '../../research/tweet-classifier/prompt-final.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown;
    expect(CATEGORY_QUESTION).toEqual(frozen);
  });
});
