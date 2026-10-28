#!/usr/bin/env python3
"""Final transparent multi-stage report, with no further inference or refinement."""
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text())


def pct(value):
    return f'{value * 100:.1f}%'


def main():
    phase2 = read('frozen-phase2.json')
    validation = read('validation-v3.summary.json')
    dev = read('phase2-development-v3.summary.json')
    q = read('prompt-v3.json')
    (ROOT / 'prompt-final.json').write_bytes((ROOT / 'prompt-v3.json').read_bytes())
    prompt = [
        '# Three-choice announcement prompt', '',
        'Model: `perplexity/pplx-decider-v1.2` (27B, non-Flash).', '',
        '**Status:** final research candidate, not a claim of guaranteed high accuracy. '
        'Read REPORT.md for development failures and independent-set results.', '',
        'Use `prompt-final.json` as `questions.category` in Vercel `POST /v1/evaluate`.', '',
        '## Instructions', '', q['instructions'], '', '## Choices', '',
    ]
    for label, description in q['criteria'].items():
        prompt += [f'### `{label}`', '', description, '']
    prompt += [
        '## Input contract', '',
        'Supply only the new focal post plus explicitly linked earlier parent/quote context:', '',
        '```json',
        '{"post":{"text":"<new post>","is_monitored_author":true},"linked_earlier_context":[]}',
        '```', '',
        'Context records, when present, contain `relation` (parent/quote), `depth` (1–3), `text`, '
        'and `is_monitored_author`. Never use future replies or unrelated recent posts. No labels, '
        'annotation rationales, post IDs, engagement statistics or split names enter model state.', '',
        '## Output', '',
        'One native choice: `reset`, `feature` or `neither`, with a probability for each. '
        'Reset takes priority if both are announced. No free-form output parser is required.', '',
        'Grounded timing/completion follow-ups can also be reset; event-level notification '
        'deduplication is a separate integration concern.', '',
        '## Evaluation prompts', '',
        'Use EVALUATION-RUBRIC.md to independently annotate future examples before making predictions. '
        'The evaluation harness keeps the answer keys outside the model request. No few-shot examples, '
        'tweet-specific answers or day-number mappings are in this prompt.', '',
    ]
    (ROOT / 'PROMPT.md').write_text('\n'.join(prompt))
    ledger = [json.loads(line) for line in (ROOT / 'ledger.jsonl').read_text().splitlines()]
    total_cost = sum((Decimal(e['cost']) for e in ledger if e['event'] == 'completed'), Decimal(0))
    runs = [
        ('v1 development', 'development-v1-paced.summary.json'),
        ('v2 development', 'development-v2.summary.json'),
        ('v2 original chronological holdout', 'holdout.summary.json'),
        ('v2 synthetic challenge', 'challenge.summary.json'),
        ('v3 consumed holdout → development', 'phase2-development-v3.summary.json'),
        ('v3 NEW retrospective validation', 'validation-v3.summary.json'),
    ]
    lines = [
        '# Reset / feature / neither: final research results', '',
        '## Bottom line', '',
        f"Final candidate: **`prompt-v3.json`**, model **`{phase2['model']}`**.",
        f"New retrospective validation: **{validation['correct']}/{validation['n']} "
        f"({pct(validation['accuracy'])})**, macro-F1 **{validation['macro_f1']:.3f}**.",
        'This is a small single-account experiment with assistant-assigned provisional labels, '
        'not proof of future or production accuracy. No bot integration or deployment was performed.', '',
        '## All iterations, including failed tests', '',
        '| Run | Correct | Accuracy | Macro-F1 | Always-neither baseline |',
        '| --- | --- | --- | --- | --- |',
    ]
    for title, name in runs:
        result = read(name)
        lines.append(f"| {title} | {result['correct']}/{result['n']} | {pct(result['accuracy'])} | "
                     f"{result['macro_f1']:.3f} | {pct(result['always_neither_accuracy'])} |")
    lines += [
        '', '### Why a second test set was necessary', '',
        'The v2 prompt scored 97.9% on development but missed 10/11 reset posts in its original '
        'chronological holdout. Its 100% synthetic result did not rescue that failure. '
        'The consumed holdout was explicitly promoted to development; improved v3 scores there '
        'are **not unseen accuracy**. One shorter final revision was frozen before testing '
        'on a newly collected nonoverlapping sample of older posts. No v4 was created.', '',
        '## Final validation details', '',
        f"95% Wilson accuracy interval: **{pct(validation['accuracy_wilson95'][0])}–"
        f"{pct(validation['accuracy_wilson95'][1])}**. Related posts are not independent, so this "
        'interval can be optimistic.', '',
        '| Class | Support | Precision | Recall | F1 |', '| --- | --- | --- | --- | --- |',
    ]
    for label, stats in validation['per_class'].items():
        lines.append(f"| {label} | {stats['support']} | {pct(stats['precision'])} | "
                     f"{pct(stats['recall'])} | {stats['f1']:.3f} |")
    lines += ['', 'Confusion matrix (rows = annotated, columns = predicted):', '',
              '| True | reset | feature | neither | error |', '| --- | --- | --- | --- | --- |']
    for label, counts in validation['confusion_matrix'].items():
        lines.append('| ' + label + ' | ' + ' | '.join(str(counts[k]) for k in ['reset', 'feature', 'neither', 'error']) + ' |')
    fixtures = {r['id']: r for name in ['historical.json', 'validation.json'] for r in read(name)}
    for title, summary in [('New validation errors', validation), ('v3 development errors (already seen data)', dev)]:
        lines += ['', f'### {title}', '']
        if not summary['errors']:
            lines.append('- None on this run.')
        for error in summary['errors']:
            fixture = fixtures[error['id']]
            text = fixture['state']['post']['text'].replace('\n', ' ')
            lines += [f"- **{error['expected']} → {error['predicted']}** "
                      f"([post]({fixture['source_url']})): {text}",
                      f"  - Label rationale: {fixture['rationale']}"]
            if error.get('error'):
                lines.append(f"  - Request failure: {error['error']}")
    lines += [
        '', '## Anti-cheating / leakage controls', '',
        '- No historical examples, known answers, tweet-ID lookups or day-number mappings in any prompt.',
        '- All answer labels and rationales fixed before corresponding inference; none were changed to match predictions.',
        '- Model request body includes only model ID, the general choice question and unlabeled post/context state.',
        '- Context is explicitly linked earlier text only, at most three hops; no future thread replies.',
        '- Final validation posts do not overlap the original 102 focal posts. Selection is every third '
        'chronological item from 154 independently collected older posts, producing 52 cases.',
        '- v3 prompt and validation hashes frozen before any v3 predictions; no further prompt changes '
        'after validation inspection. Hashes in frozen-phase2.json.',
        '- All predictions and errors retained; low-confidence answers are not excluded. Transport failures '
        'count as wrong. Synthetic and real results are never blended.', '',
        '## Limits and assumptions', '',
        '- Manual labels are this assistant’s provisional interpretation of protocol.md, not independent '
        'user-approved or multi-annotator ground truth. Borderline labels may need user adjudication.',
        '- All text was visible to the assistant during collection. Held-out means not used for '
        'model-guided refinement; this is not a human-blind trial. Historical model-training '
        'contamination cannot be ruled out.',
        '- The fresh test is older, retrospective traffic, NOT future chronological confirmation. '
        'Selection from the main timeline underrepresents ordinary standalone replies relative to the original set.',
        '- Some posts depend on images or videos, which this text-only study does not interpret. '
        'A URL or ungrounded completion alone does not establish an announcement.',
        '- A definite scheduled release counts as feature; vague undated intentions do not. '
        'Billing restitution is neither. A promised missing quota reset finally applied is reset. '
        'Reset wins when reset and feature coexist.',
        '- A high probability does not guarantee correctness. No confidence thresholds were tuned to hide errors.',
        '- Classification is not notification deduplication: reset timing/completion updates may need '
        'to update the existing notification rather than send another one.',
        '- The original chronological holdout failure remains material evidence; do not market this as '
        'a 97.9% production classifier based on its development result.', '',
        '## Existing-credit usage and safety', '',
        f'- Recorded successful inference cost across **all stages**: **${total_cost}** from the existing $5 balance.',
        '- No purchases, top-ups, billing changes, paid-tier upgrades or model fallbacks. '
        'No Discord-connected process started; production and runtime data untouched.',
        '- Approximately five requests/minute inferred from a 429 after the sixth rapid call; '
        'paced to starts at least 13 seconds apart. Bounded backoff respects 429 Retry-After.',
        '- Maximum logical-call budget 400 and maximum existing-credit spend $0.05; unresolved '
        'request costs conservatively retain a reservation in ledger.jsonl.', '',
        '## Saved artifacts', '',
        '- **PROMPT.md / prompt-final.json**: final v3 classifier, readable and API-ready forms.',
        '- **EVALUATION-RUBRIC.md**: reusable independent annotation and future-test instructions.',
        '- **protocol.md / phase2-protocol.md**: fixed policy and explicit second-stage amendment.',
        '- **refinement.md**: general changes and their reasons.',
        '- **REPORT-phase1.md**: first-stage report, including failed chronological holdout. '
        'It predates second-stage results; its final-candidate references mean v2 at that time.',
        '- **historical.json / validation.json / challenges.json**: fixtures and answer keys stored '
        'outside model state. **frozen*.json**: timestamped prompt/dataset hashes.',
        '- **evaluate.py**: reproducible standalone harness, dry-run by default. '
        'No import or modification of live bot code.',
        '- **\u002a.jsonl / \u002a.summary.json / ledger.jsonl**: predictions, per-class metrics, errors and credit trail.', '',
        '## Verification and reproduction', '',
        '```sh',
        'python3 -m unittest discover -s research/tweet-classifier -p "test_*.py" -v',
        '# Dry-run only (does not spend credits):',
        'python3 research/tweet-classifier/evaluate.py --split validation --phase2 \\',
        '  --prompt prompt-final.json --output new-validation-run.jsonl',
        '```', '',
        'Adding `--execute` consumes existing credits; do not rerun without authorization. '
        'Normalized fixtures are sufficient for reproducible inference. Collection scripts depend '
        'on original public-data snapshots under /tmp/felicity-tweet-research, which are not committed.', '',
        '## Sources', '',
        '- [FxTwitter timeline API](https://docs.fxembed.com/api/twitter/operations/2profilehandlestatuses/)',
        '- [Vercel Decision API](https://vercel.com/docs/ai-gateway/capabilities/evaluation)',
        '- [Vercel model availability](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)',
        '- [Vercel free-tier rate limits](https://vercel.com/docs/ai-gateway/rate-limits)', '',
    ]
    (ROOT / 'REPORT.md').write_text('\n'.join(lines))
    print('Saved final prompt and REPORT.md')
    print(json.dumps({'validation_accuracy': validation['accuracy'], 'validation_macro_f1': validation['macro_f1'],
                      'total_recorded_cost': str(total_cost)}))


if __name__ == '__main__':
    main()
