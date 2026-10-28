// Offline replay of a real historical post and its recorded v3 model confidence.
// Rendering only: never used as examples or lookup rules in the classifier.
// Provenance: historical.json and phase2-development-v3.jsonl in research/tweet-classifier.
import type { Decision, Tweet } from './types.js';

export const PREVIEW_TWEET: Tweet = {
  id: '2114588174249071102',
  text: 'Day 21/ Wonder what happens the remaining seven days. But today is a reset.',
  createdAt: 0,
  context: [],
};
export const PREVIEW_DECISION: Decision = {
  category: 'reset',
  confidence: 0.8848731585381278,
};
