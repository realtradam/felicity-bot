import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORY_QUESTION } from './prompt.js';
import { formatNotification, sampleNotification } from './format.js';
import type { Tweet } from './types.js';
import { PREVIEW_DECISION, PREVIEW_TWEET } from './preview.js';

const post: Tweet = {
  id: '2115273253711409208',
  text: 'Limits reset today.',
  createdAt: 123,
  context: [],
};

describe('notification output', () => {
  it('uses party popper for resets and wilted rose for updates', () => {
    expect(
      formatNotification(post, { category: 'reset', confidence: 0.9 }),
    ).toMatch(/^🎉 OpenAI usage reset\n/);
    expect(
      formatNotification(post, { category: 'feature', confidence: 0.9 }),
    ).toMatch(/^🥀 OpenAI challenge update\n/);
  });
  it('shows the actual chosen category probability, never a hardcoded confidence', () => {
    expect(
      formatNotification(post, { category: 'reset', confidence: 0.632 }),
    ).toContain('AI confidence: **63.2%** (model estimate)');
    expect(
      formatNotification(post, { category: 'feature', confidence: 0.819 }),
    ).toContain('OpenAI challenge update');
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
  it('replays stored real history through identical live formatting without test labels', () => {
    const output = sampleNotification();
    expect(output).toBe(formatNotification(PREVIEW_TWEET, PREVIEW_DECISION));
    expect(output).toContain('88.5%');
    expect(output).toContain(`/status/${PREVIEW_TWEET.id}`);
    expect(output).not.toMatch(
      /SAMPLE|Preview only|example value|not a real announcement/,
    );
  });
  it('does not turn a challenge update into a guarantee of no reset later that day', () => {
    const output = formatNotification(post, {
      category: 'feature',
      confidence: 0.9,
    });
    expect(output).toContain('No reset announced in this post.');
    expect(output).not.toContain('no reset today');
  });
  it('keeps the runtime prompt identical to the explicit challenge-policy prompt, not the old generic prompt', () => {
    const frozen = JSON.parse(
      readFileSync(
        new URL(
          '../../research/tweet-classifier/prompt-v4-challenge.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown;
    expect(CATEGORY_QUESTION).toEqual(frozen);
  });
});
