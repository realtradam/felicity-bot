#!/usr/bin/env python3
"""Deterministic new retrospective validation selection; run before v3 inference."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SNAPSHOT = Path('/tmp/felicity-tweet-research')
posts = json.loads((SNAPSHOT / 'older-posts.json').read_text())
pages = json.loads((SNAPSHOT / 'older-pages.json').read_text())
all_posts = {}


def collect(value):
    if isinstance(value, dict):
        if value.get('type') == 'status' and value.get('id') and value.get('text'):
            all_posts[value['id']] = value
        for child in value.values():
            collect(child)
    elif isinstance(value, list):
        for child in value:
            collect(child)


collect(pages)
all_posts.update({p['id']: p for p in posts})
# Manual provisional labels fixed before calls, never supplied to inference.
resets = {6, 24, 48, 87, 90, 93, 123, 135, 144, 150}
features = {3, 42, 57, 60, 84, 102, 111, 126, 129, 132, 147}
notes = {
    18: 'Pause of new subscriptions, no new capability/improvement or quota reset.',
    21: 'Retirement of an old model, not a new capability or improvement.',
    33: 'Praise of existing model benchmark results, not a new product release.',
    54: 'Teaser and reaction to earlier news, no concrete new release in focal post.',
    63: 'Existing plan inclusion clarification and vague future expansion.',
    66: 'General launch-day recap with no specific capability established in linked text.',
    75: 'Corrects misinformation about existing plan inclusions, not a new change.',
    93: 'Completion of an identified missing quota reset, not mere billing refund.',
    108: 'Advice on using existing permission mode, not announcement of a change.',
    123: 'Timing follow-up directly linked to a real reset announcement.',
    150: 'Completion quote chain links back to quota reset, using earlier text only.',
}
records = []
for index in range(0, len(posts), 3):
    focal = posts[index]
    if not focal.get('text'):
        continue
    context = []; seen = {focal['id']}; queue = [(focal, 0)]
    while queue:
        current, depth = queue.pop(0)
        if depth >= 3:
            continue
        quote = current.get('quote') or {}
        parent_id = (current.get('replying_to') or {}).get('status')
        for relation, linked in [('parent', all_posts.get(parent_id)),
                                 ('quote', all_posts.get(quote.get('id')) or quote)]:
            if not linked or not linked.get('text') or linked.get('id') in seen:
                continue
            if linked.get('created_timestamp', float('inf')) > focal['created_timestamp']:
                continue
            seen.add(linked.get('id'))
            context.append({'relation': relation, 'depth': depth + 1, 'text': linked['text'],
                            'is_monitored_author': (linked.get('author') or {}).get('screen_name') == 'thsottiaux'})
            queue.append((linked, depth + 1))
    label = 'reset' if index in resets else 'feature' if index in features else 'neither'
    records.append({'id': focal['id'], 'source_url': focal['url'], 'published_at': focal['created_at'],
                    'split': 'validation',
                    'state': {'post': {'text': focal['text'], 'is_monitored_author': True},
                              'linked_earlier_context': context},
                    'expected': label,
                    'rationale': notes.get(index, 'Announces or confirms quota reset.' if label == 'reset'
                                           else 'Concrete new OpenAI capability or shipped improvement.' if label == 'feature'
                                           else 'No concrete new OpenAI feature or quota reset.')})
original_ids = {r['id'] for r in json.loads((ROOT / 'historical.json').read_text())}
assert not original_ids.intersection(r['id'] for r in records)
(ROOT / 'validation.json').write_text(json.dumps(records, indent=2, ensure_ascii=False) + '\n')
print('Validation cases', len(records), {label: sum(r['expected'] == label for r in records)
                                       for label in ['reset', 'feature', 'neither']})
print('Dataset SHA-256', hashlib.sha256((ROOT / 'validation.json').read_bytes()).hexdigest())
