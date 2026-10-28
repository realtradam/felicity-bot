#!/usr/bin/env python3
"""Bounded standalone Decision API evaluation; never imports or starts the bot.

Inference requires --execute. Uses existing Gateway credits only; no billing APIs,
bounded 429 retries, no fallbacks, and only the fixed model below. Labels are never sent.
"""
import argparse
import hashlib
import json
import math
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODEL = 'perplexity/pplx-decider-v1.2'
BASE = 'https://ai-gateway.vercel.sh/v1'
LABELS = ('reset', 'feature', 'neither')
BUDGET = Decimal('0.05')
RESERVATION = Decimal('0.0005')
MAX_CALLS = 400
LEDGER = ROOT / 'ledger.jsonl'


def credential():
    # Parse one known dotenv field; never execute the file or print credential values.
    env = ROOT.parents[1] / '.env'
    for line in env.read_text().splitlines():
        match = re.match(r'^\s*VERCEL_TOKEN\s*=\s*(.*?)\s*$', line)
        if match:
            return match.group(1).strip('\"\'')
    raise SystemExit('Gateway credential missing.')


def request(path, key, body=None):
    req = urllib.request.Request(BASE + path,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
        data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=45) as response:
        return json.load(response)


def preflight(key):
    catalog = request('/models?include_availability', key)
    model = next((m for m in catalog['data'] if m['id'] == MODEL), None)
    if not model or model.get('model_eligibility', {}).get('status') != 'eligible':
        raise SystemExit('Fixed model is not eligible; stopping without fallback.')
    if catalog.get('request_context_availability', {}).get('http', {}).get('status') != 'available':
        raise SystemExit('Account not available; stopping.')
    if Decimal(model['pricing']['input']) > Decimal('0.00000002') or Decimal(model['pricing']['output']) != 0:
        raise SystemExit('Price changed; stopping.')
    credits = request('/credits', key)
    if Decimal(credits['balance']) < Decimal('0.10'):
        raise SystemExit('Insufficient existing credit reserve; no top-up attempted.')
    return credits


def load_ledger():
    return [json.loads(line) for line in LEDGER.read_text().splitlines()] if LEDGER.exists() else []


def charged(events):
    # An unresolved request retains its full reservation even if the client failed.
    pending = {}; completed = {}
    for event in events:
        if event['event'] == 'reserved':
            pending[event['call']] = Decimal(event['reserve'])
        elif event['event'] == 'completed':
            completed[event['call']] = Decimal(event['cost'])
    return sum((completed.get(k, v) for k, v in pending.items()), Decimal(0)), len(pending)


def append(path, record):
    with path.open('a') as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + '\n')
        stream.flush()


def metrics(rows):
    matrix = {label: {p: 0 for p in (*LABELS, 'error')} for label in LABELS}
    for row in rows:
        matrix[row['expected']][row['predicted'] if row['predicted'] in LABELS else 'error'] += 1
    correct = sum(matrix[label][label] for label in LABELS)
    n = len(rows); accuracy = correct / n if n else 0
    per_class = {}
    for label in LABELS:
        tp = matrix[label][label]; support = sum(matrix[label].values())
        positives = sum(matrix[truth][label] for truth in LABELS)
        precision = tp / positives if positives else 0
        recall = tp / support if support else 0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0
        per_class[label] = {'support': support, 'precision': precision, 'recall': recall, 'f1': f1}
    z = 1.96
    if n:
        center = (accuracy + z*z/(2*n)) / (1+z*z/n)
        half = z * math.sqrt(accuracy*(1-accuracy)/n+z*z/(4*n*n))/(1+z*z/n)
        interval = [center-half, center+half]
    else:
        interval = [0, 1]
    return {'n': n, 'correct': correct, 'accuracy': accuracy, 'accuracy_wilson95': interval,
            'macro_f1': sum(x['f1'] for x in per_class.values()) / 3,
            'always_neither_accuracy': sum(r['expected'] == 'neither' for r in rows)/n if n else 0,
            'per_class': per_class, 'confusion_matrix': matrix,
            'errors': [r for r in rows if r['expected'] != r['predicted']]}


def validate_answer(result):
    if result.get('model') != MODEL:
        raise ValueError('Unexpected model identity')
    answer = result['answers']['category']
    probabilities = answer['probabilities']
    if answer.get('type') != 'choice' or answer.get('choice') not in LABELS or set(probabilities) != set(LABELS):
        raise ValueError('Invalid choice schema')
    if not all(isinstance(p, (float, int)) and math.isfinite(p) and 0 <= p <= 1 for p in probabilities.values()):
        raise ValueError('Invalid probabilities')
    if abs(sum(probabilities.values()) - 1) > .02:
        raise ValueError('Probabilities do not sum to one')
    return answer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--split', choices=['development', 'holdout', 'challenge', 'validation', 'scope'], required=True)
    parser.add_argument('--prompt', required=True)
    parser.add_argument('--phase2', action='store_true', help='Use explicit second-stage freeze; original holdout is now development.')
    parser.add_argument('--output', required=True)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--reuse', help='Reuse successful identical baseline requests, preserving original run.')
    parser.add_argument('--delay', type=float, default=13, help='Minimum seconds between inference starts.')
    args = parser.parse_args()
    prompt_path = ROOT / args.prompt; output = ROOT / args.output
    prompt = json.loads(prompt_path.read_text())
    if prompt.get('type') != 'choice' or set(prompt.get('criteria', {})) != set(LABELS):
        raise SystemExit('Prompt must define exactly the three choices.')
    dataset = ROOT / ('challenge-scope-cases.json' if args.split == 'scope' else 'challenges.json' if args.split == 'challenge' else 'validation.json' if args.split == 'validation' else 'historical.json')
    fixtures = [r for r in json.loads(dataset.read_text()) if args.split == 'scope' or r['split'] == args.split]
    if args.limit:
        fixtures = fixtures[:args.limit]
    prompt_hash = hashlib.sha256(prompt_path.read_bytes()).hexdigest()
    print(json.dumps({'model': MODEL, 'split': args.split, 'cases': len(fixtures),
                      'prompt_sha256': prompt_hash, 'execute': args.execute}))
    if not args.execute:
        return
    if output.exists():
        raise SystemExit('Output exists; refusing overwrite or hidden rerun.')
    if args.split != 'development':
        frozen = json.loads((ROOT / ('frozen-challenge-scope.json' if args.split == 'scope' else 'frozen-phase2.json' if args.phase2 else 'frozen.json')).read_text())
        if frozen['prompt_sha256'] != prompt_hash or frozen['dataset_sha256'][dataset.name] != hashlib.sha256(dataset.read_bytes()).hexdigest():
            raise SystemExit('Frozen prompt/dataset mismatch.')
    key = credential(); before = preflight(key); rows = []
    reused = {}
    if args.reuse:
        old_path = ROOT / args.reuse
        old_summary = json.loads(old_path.with_suffix('.summary.json').read_text())
        if old_summary['prompt_sha256'] != prompt_hash or old_summary['dataset_sha256'] != hashlib.sha256(dataset.read_bytes()).hexdigest():
            raise SystemExit('Cannot reuse predictions from a different prompt/dataset.')
        reused = {r['id']: r for r in (json.loads(line) for line in old_path.read_text().splitlines())
                  if r.get('predicted') in LABELS}
    next_allowed = 0
    for case in fixtures:
        if case['id'] in reused:
            row = {**reused[case['id']], 'reused_from': args.reuse}
            rows.append(row); append(output, row)
            print(case['id'], row['predicted'], 'reused', flush=True)
            continue
        time.sleep(max(0, next_allowed - time.monotonic()))
        events = load_ledger(); spent, calls = charged(events)
        if calls >= MAX_CALLS or spent + RESERVATION > BUDGET:
            raise SystemExit('Experiment cap reached; stopping.')
        # Whitelist only state fields; labels/rationales/IDs/splits are never sent.
        body = {'model': MODEL, 'state': case['state'], 'questions': {'category': prompt}}
        if len(json.dumps(body).encode()) > 18000:
            raise SystemExit('Request exceeds conservative input-size budget.')
        call = calls + 1
        append(LEDGER, {'event': 'reserved', 'call': call, 'reserve': str(RESERVATION),
                        'utc': datetime.now(timezone.utc).isoformat()})
        start = time.monotonic()
        row = {'id': case['id'], 'expected': case['expected'], 'predicted': 'error'}
        try:
            for attempt in range(3):
                next_allowed = time.monotonic() + max(args.delay, 13)
                try:
                    result = request('/evaluate', key, body)
                    break
                except urllib.error.HTTPError as rate_error:
                    if rate_error.code != 429 or attempt == 2:
                        raise
                    retry_after = rate_error.headers.get('Retry-After', '')
                    delay = max(60 * (2 ** attempt), float(retry_after) if retry_after.isdigit() else 0)
                    append(LEDGER, {'event': 'rate_limited', 'call': call, 'attempt': attempt + 1, 'wait_seconds': delay})
                    print('429: waiting', delay, 'seconds before bounded same-request retry.', flush=True)
                    time.sleep(delay)
            answer = validate_answer(result)
            meta = result.get('providerMetadata', {}).get('gateway', {})
            cost = Decimal(str(meta.get('cost', RESERVATION)))
            append(LEDGER, {'event': 'completed', 'call': call, 'cost': str(cost)})
            row.update(predicted=answer['choice'], probabilities=answer['probabilities'],
                       usage=result.get('usage'), cost=str(cost), model=result.get('model'))
        except urllib.error.HTTPError as error:
            row['error'] = 'HTTP ' + str(error.code)  # Never echo raw errors or request headers.
            append(output, row); rows.append(row)
            print('Request failed:', row['error'], '; stopping after bounded rate-limit retries; no fallback.')
            break
        except Exception as error:
            row['error'] = type(error).__name__
        row['latency_seconds'] = round(time.monotonic() - start, 3)
        rows.append(row); append(output, row)
        print(case['id'], row['predicted'], 'expected', case['expected'], flush=True)
        time.sleep(.25)
    # Include unattempted cases as failures if the run stopped early.
    attempted = {r['id'] for r in rows}
    for case in fixtures:
        if case['id'] not in attempted:
            rows.append({'id': case['id'], 'expected': case['expected'], 'predicted': 'error', 'error': 'not attempted'})
    summary = metrics(rows)
    after = request('/credits', key)
    summary.update(model=MODEL, prompt_sha256=prompt_hash,
                   dataset_sha256=hashlib.sha256(dataset.read_bytes()).hexdigest(),
                   split=args.split, credits_before=before, credits_after=after,
                   reported_cost=str(sum((Decimal(r.get('cost', '0')) for r in rows), Decimal(0))))
    output.with_suffix('.summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({k: summary[k] for k in ['n', 'correct', 'accuracy', 'macro_f1', 'reported_cost']}))


if __name__ == '__main__':
    main()
