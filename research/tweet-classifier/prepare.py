#!/usr/bin/env python3
"""Offline fixture preparation from the read-only FxTwitter research snapshot."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SNAPSHOT = Path('/tmp/felicity-tweet-research')
posts = json.loads((SNAPSHOT / 'posts.json').read_text())
pages = json.loads((SNAPSHOT / 'raw-pages.json').read_text())
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
all_posts.update({post['id']: post for post in posts})
reset_indices = {17, 18, 45, 54, 55, 58, 59, 73, 74, 77, 82, 93, 94, 101}
feature_indices = {1, 2, 3, 8, 35, 47, 60, 61, 88}
rationales = {
    3: 'Endorses a concrete home-screen release in the quoted post.',
    7: 'Feedback request about an existing product; no concrete new change.',
    20: 'Personal usage story, not a new capability announcement.',
    26: 'Ungrounded completion with no linked text context; cannot infer a reset.',
    29: 'Undated in-progress regional roadmap, not an available or definite scheduled release.',
    32: 'Discussion of requests for resets, not an announcement.',
    37: 'Incident restitution and access reminder, not a new release or quota reset.',
    43: 'Broadcast teaser without a concrete new capability in supplied text.',
    46: 'Billing/plan correction and restitution, not product feature or quota reset announcement.',
    48: 'Requests a reset from another author; does not announce one.',
    50: 'Greeting a competitor product, not announcing an OpenAI release.',
    52: 'Unexplained wordplay with no textual announcement.',
    53: 'Existing plan inclusion clarification, without a stated change.',
    58: 'Real reset takes priority over multiple simultaneous feature announcements.',
    64: 'Personal work activity, not a shipped fix announcement.',
    75: 'Joking demand directed at a third-party product, not an OpenAI reset.',
    77: 'Confirms propagation; explicit quote-to-parent chain establishes quota reset.',
    84: 'Reminder of existing settings, not a new feature.',
    87: 'Joking complaint about another bot, not quota-reset announcement.',
    93: 'Author retracts feature framing and explicitly announces reset; reset wins.',
    95: 'Reaction to speculation and plan complaint; no concrete announcement.',
    97: 'Reaction to historical reset count, not a new reset.',
    98: 'Unrelated personal domain launch; no evidence of OpenAI product capability.',
    99: 'Acknowledges feature request, not a release commitment.',
    100: 'Generic praise of existing GPT functionality, not a new change.',
    101: 'Confirmation linked by quote and its parent to a reset; vague future teaser adds nothing.',
}


def compact(post):
    return {
        'text': post['text'],
        'is_monitored_author': (post.get('author') or {}).get('screen_name') == 'thsottiaux',
    }


def state_for(post):
    # Only earlier, explicitly linked context. Never include later thread replies.
    context = []
    seen = {post['id']}
    frontier = [(post, 0)]
    while frontier:
        current, depth = frontier.pop(0)
        if depth >= 3:
            continue
        parent_id = (current.get('replying_to') or {}).get('status')
        quote = current.get('quote') or {}
        for relation, linked in [('parent', all_posts.get(parent_id)),
                                 ('quote', all_posts.get(quote.get('id')) or quote)]:
            if not linked or not linked.get('text') or linked.get('id') in seen:
                continue
            if linked.get('created_timestamp', float('inf')) > post['created_timestamp']:
                continue
            seen.add(linked.get('id'))
            context.append({'relation': relation, 'depth': depth + 1, **compact(linked)})
            frontier.append((linked, depth + 1))
    return {'post': compact(post), 'linked_earlier_context': context}


records = []
boundary = datetime(2026, 10, 21, tzinfo=timezone.utc).timestamp()
for index, post in enumerate(posts):
    label = 'reset' if index in reset_indices else 'feature' if index in feature_indices else 'neither'
    records.append({
        'id': post['id'], 'source_url': post['url'], 'published_at': post['created_at'],
        'split': 'development' if post['created_timestamp'] < boundary else 'holdout',
        'state': state_for(post), 'expected': label,
        'rationale': rationales.get(index, 'Explicit quota reset or linked timing.' if label == 'reset'
                                    else 'Concrete new OpenAI capability or shipped improvement.' if label == 'feature'
                                    else 'No concrete new OpenAI feature or quota-reset announcement.'),
    })
(ROOT / 'historical.json').write_text(json.dumps(records, indent=2, ensure_ascii=False) + '\n')
manifest = {
    'snapshot_sha256': hashlib.sha256((SNAPSHOT / 'raw-pages.json').read_bytes()).hexdigest(),
    'dataset_sha256': hashlib.sha256((ROOT / 'historical.json').read_bytes()).hexdigest(),
    'collected_at_utc': datetime.now(timezone.utc).isoformat(),
    'source': 'https://api.fxtwitter.com/2/profile/thsottiaux/statuses?count=100&with_replies=true',
    'pages': len(pages), 'authored_posts': len(posts),
    'ground_truth': 'Assistant manual provisional labels, assigned before inference.',
}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
for split in ['development', 'holdout']:
    subset = [r for r in records if r['split'] == split]
    print(split, len(subset), {label: sum(r['expected'] == label for r in subset)
                              for label in ['reset', 'feature', 'neither']})
