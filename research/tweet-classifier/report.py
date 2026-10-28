#!/usr/bin/env python3
"""Render the final research report from saved, immutable prediction records."""
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load(name):
    return json.loads((ROOT / name).read_text())


def percent(value):
    return f'{100 * value:.1f}%'


def main():
    freeze = load('frozen.json')
    files = ['development-v1-paced.summary.json', 'development-v2.summary.json']
    if (ROOT / 'development-v3.summary.json').exists():
        files.append('development-v3.summary.json')
    files.extend(['holdout.summary.json', 'challenge.summary.json'])
    summaries = [(name, load(name)) for name in files]
    historical = {r['id']: r for r in load('historical.json')}
    challenges = {r['id']: r for r in load('challenges.json')}
    ledgers = [json.loads(line) for line in (ROOT / 'ledger.jsonl').read_text().splitlines()]
    cost = sum((Decimal(e['cost']) for e in ledgers if e['event'] == 'completed'), Decimal(0))
    lines = [
        '# Reset / feature / neither: decision-prompt evaluation', '',
        '## Summary', '',
        f"Model: **`{freeze['model']}`**. Selected zero-shot prompt: **{freeze['prompt']}**.",
        'No examples, answer keys, tweet-ID rules or day-number lookups are included in the prompt.',
        'This is a standalone research experiment; no bot integration or deployment was performed.', '',
        '## Measured results', '',
        '| Run | Correct / cases | Accuracy | Macro-F1 | Always-neither accuracy |',
        '| --- | --- | --- | --- | --- |',
    ]
    for name, summary in summaries:
        lines.append(f"| {name.removesuffix('.summary.json')} | {summary['correct']}/{summary['n']} | "
                     f"{percent(summary['accuracy'])} | {summary['macro_f1']:.3f} | "
                     f"{percent(summary['always_neither_accuracy'])} |")
    lines += ['', 'Accuracy includes transport errors as wrong. Macro-F1 gives each class equal weight.',
              'Do not combine development accuracy with test accuracy to claim generalization.', '']
    for name, summary in summaries:
        lines += [f"### {name.removesuffix('.summary.json')}", '',
                  f"95% Wilson accuracy interval: {percent(summary['accuracy_wilson95'][0])}–"
                  f"{percent(summary['accuracy_wilson95'][1])}.", '',
                  '| Class | Support | Precision | Recall | F1 |', '| --- | --- | --- | --- | --- |']
        for label, stats in summary['per_class'].items():
            lines.append(f"| {label} | {stats['support']} | {percent(stats['precision'])} | "
                         f"{percent(stats['recall'])} | {stats['f1']:.3f} |")
        lines += ['', 'Confusion matrix (rows = true, columns = predicted):', '',
                  '| True | reset | feature | neither | error |', '| --- | --- | --- | --- | --- |']
        for label, counts in summary['confusion_matrix'].items():
            lines.append('| ' + label + ' | ' + ' | '.join(str(counts[k]) for k in ['reset', 'feature', 'neither', 'error']) + ' |')
        lines += ['', 'Errors:', '']
        if not summary['errors']:
            lines.append('- None on this saved run.')
        for error in summary['errors']:
            fixture = historical.get(error['id']) or challenges[error['id']]
            text = fixture['state']['post']['text'].replace('\n', ' ')
            source = f"[source]({fixture['source_url']})" if fixture.get('source_url') else 'synthetic'
            lines += [f"- **{error['expected']} → {error['predicted']}** ({source}): {text}",
                      f"  - Provisional label rationale: {fixture['rationale']}"]
            if error.get('error'):
                lines.append(f"  - Transport/validation error: {error['error']}")
        lines.append('')
    lines += [
        '## Rules and refinement', '',
        '- Version 1: short generic zero-shot classifier.',
        '- Version 2: explicit account/product context; shorthand reset announcements; grounded timing/completion; '
        'endorsed quote releases; exclusion of billing restitution and existing-plan reminders. '
        'These changes were based only on development errors and preserve the original label policy.',
    ]
    if (ROOT / 'prompt-v3.json').exists():
        lines.append('- Version 3: see revision notes in `refinement.md`; created from development errors only.')
    lines += [
        f"- Final prompt frozen at {freeze['frozen_at_utc']}; SHA-256 `{freeze['prompt_sha256']}`.",
        '- Holdout and synthetic challenge were run only after that freeze. No prompt changes after test inspection.', '',
        '## Validity and limitations', '',
        '- Historical corpus: 102 authored posts from one account, October 16–28, 2026, obtained through FxTwitter. '
        'The upstream stopped returning older pages; completeness is not established.',
        '- Chronological split: 47 development posts before October 21; 55 later holdout posts. '
        'Holdout contains only 11 reset and 4 feature cases, so per-class estimates are particularly uncertain.',
        '- Labels were assigned by this assistant before inference, not by an independent annotator or the user. '
        'Reported accuracy means agreement with this explicit provisional policy, not objective truth.',
        '- All texts were visible during dataset collection; holdout is held out from model-guided refinement, '
        'not claimed to be blind to the assistant. Model training contamination cannot be excluded.',
        '- Context includes only explicitly linked preceding text. No future replies, labels, rationales, splits, '
        'engagement statistics or evaluation metadata enter inference state. Text-only inputs miss image/video-only announcements.',
        '- Reset takes priority when both are announced. New shipped fixes/efficiency changes count as feature; '
        'old-feature reminders, vague undated plans, billing restitution and unrelated launches count as neither.',
        '- The synthetic challenge set is an artificial rule-oriented check, not representative observed traffic. '
        'Its cases and labels were fixed before inference and never used for refinement.',
        '- Repeated author wording and related posts reduce effective sample size. Wilson intervals assume independent cases '
        'and can therefore be optimistic here.',
        '- Model probabilities were recorded, not assumed to be calibrated. No threshold excluded difficult cases from scoring.',
        '- Prompt classification does not implement notification deduplication: an announcement, timing follow-up and '
        'completion can each be reset. Event-level deduplication remains a separate integration task.', '',
        '## Costs and operations', '',
        f'- Sum of completed-request costs recorded in ledger: **${cost}** from existing Gateway credits.',
        '- An initial rapid baseline hit HTTP 429. Its partial report is retained separately; paced baseline reused '
        'only identical successful requests verified by prompt and dataset hashes.',
        '- Paced requests start at least 13 seconds apart, with bounded 429 backoff. No billing changes, top-ups, '
        'new subscriptions, Discord login or live bot mutations.',
        '- The ledger conservatively reserves budget for requests without a reported cost, including network failures. '
        'Gateway balance deltas in each summary can differ from summed costs because reporting is asynchronous.', '',
        '## Files and reproduction', '',
        '- `prompt-final.json`: deployable single-choice question object. Supply actual post/context separately as state.',
        '- `PROMPT.md`: human-readable prompt and allowed input/output contract.',
        '- `protocol.md`: pre-inference label policy, split and selection rules.',
        '- `historical.json`, `challenges.json`: fixtures with labels/rationales kept outside model state.',
        '- `*.jsonl`, `*.summary.json`, `ledger.jsonl`: raw predictions, metrics and experiment cost trail.',
        '- `evaluate.py`: standalone evaluation; dry-run by default, explicit `--execute` required for inference.',
        '- Offline checks: `python3 -m unittest discover -s research/tweet-classifier -p "test_*.py" -v`.',
        '- Dry run: `python3 research/tweet-classifier/evaluate.py --split holdout --prompt prompt-final.json --output verification.jsonl`.',
        '- Executing a rerun consumes existing credits. Do not rerun until authorized; never tune against the saved holdout.',
        '- Fixture regeneration requires the original read-only collection snapshot under `/tmp/felicity-tweet-research`; '
        'the committed normalized fixtures are sufficient to reproduce inference without recollecting tweets.', '',
        '## Sources', '',
        '- [FxTwitter public timeline API](https://docs.fxembed.com/api/twitter/operations/2profilehandlestatuses/)',
        '- [Vercel Decision API](https://vercel.com/docs/ai-gateway/capabilities/evaluation)',
        '- [Vercel model eligibility endpoint](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)',
        '- [Vercel rate limits](https://vercel.com/docs/ai-gateway/rate-limits)', '',
    ]
    (ROOT / 'REPORT.md').write_text('\n'.join(lines))
    print('Saved REPORT.md')


if __name__ == '__main__':
    main()
