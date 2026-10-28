"""Offline checks. No credentials, network requests, or bot imports."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('tweet_eval', ROOT / 'evaluate.py')
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class EvaluationTests(unittest.TestCase):
    def test_fixture_labels_and_state_are_separate(self):
        for name in ['historical.json', 'challenges.json', 'validation.json']:
            records = json.loads((ROOT / name).read_text())
            self.assertEqual(len({r['id'] for r in records}), len(records))
            for record in records:
                self.assertIn(record['expected'], evaluation.LABELS)
                self.assertEqual(set(record['state']), {'post', 'linked_earlier_context'})
                self.assertEqual(set(record['state']['post']), {'text', 'is_monitored_author'})
                for context in record['state']['linked_earlier_context']:
                    self.assertEqual(set(context), {'text', 'is_monitored_author', 'relation', 'depth'})

    def test_historical_split_support(self):
        records = json.loads((ROOT / 'historical.json').read_text())
        self.assertEqual(sum(r['split'] == 'development' for r in records), 47)
        self.assertEqual(sum(r['split'] == 'holdout' for r in records), 55)

    def test_new_validation_does_not_overlap_original(self):
        old = json.loads((ROOT / 'historical.json').read_text())
        new = json.loads((ROOT / 'validation.json').read_text())
        self.assertFalse({r['id'] for r in old} & {r['id'] for r in new})
        self.assertEqual(len(new), 52)
        self.assertEqual(sum(r['expected'] == 'reset' for r in new), 10)
        self.assertEqual(sum(r['expected'] == 'feature' for r in new), 11)

    def test_freeze_hashes(self):
        import hashlib
        for name in ['frozen.json', 'frozen-phase2.json']:
            frozen = json.loads((ROOT / name).read_text())
            self.assertEqual(frozen['prompt_sha256'], hashlib.sha256((ROOT / frozen['prompt']).read_bytes()).hexdigest())
            for dataset, expected_hash in frozen['dataset_sha256'].items():
                self.assertEqual(expected_hash, hashlib.sha256((ROOT / dataset).read_bytes()).hexdigest())

    def test_perfect_metrics(self):
        rows = [{'expected': label, 'predicted': label} for label in evaluation.LABELS]
        result = evaluation.metrics(rows)
        self.assertEqual(result['accuracy'], 1)
        self.assertEqual(result['macro_f1'], 1)
        self.assertEqual(result['errors'], [])
        self.assertLess(result['accuracy_wilson95'][0], 1)

    def test_errors_are_in_denominator(self):
        result = evaluation.metrics([{'expected': 'reset', 'predicted': 'error'},
                                     {'expected': 'neither', 'predicted': 'neither'}])
        self.assertEqual(result['accuracy'], .5)
        self.assertEqual(result['confusion_matrix']['reset']['error'], 1)
        self.assertEqual(result['per_class']['reset']['recall'], 0)

    def test_unknown_cost_keeps_reservation(self):
        events = [{'event': 'reserved', 'call': 1, 'reserve': '0.0005'},
                  {'event': 'rate_limited', 'call': 1},
                  {'event': 'reserved', 'call': 2, 'reserve': '0.0005'},
                  {'event': 'completed', 'call': 2, 'cost': '0.00001'}]
        cost, calls = evaluation.charged(events)
        self.assertEqual(str(cost), '0.00051')
        self.assertEqual(calls, 2)

    def test_invalid_answers_rejected(self):
        good = {'model': evaluation.MODEL, 'answers': {'category': {
            'type': 'choice', 'choice': 'reset',
            'probabilities': {'reset': .9, 'feature': .05, 'neither': .05}}}}
        self.assertEqual(evaluation.validate_answer(good)['choice'], 'reset')
        good['model'] = 'some-other-model'
        with self.assertRaises(ValueError):
            evaluation.validate_answer(good)
        good['model'] = evaluation.MODEL
        good['answers']['category']['probabilities']['reset'] = float('nan')
        with self.assertRaises(ValueError):
            evaluation.validate_answer(good)

    def test_prompt_has_no_historical_ids_or_verbatim_answers(self):
        historical = json.loads((ROOT / 'historical.json').read_text())
        for path in ROOT.glob('prompt-v*.json'):
            prompt = json.loads(path.read_text())
            self.assertEqual(prompt['type'], 'choice')
            self.assertEqual(set(prompt['criteria']), set(evaluation.LABELS))
            text = json.dumps(prompt).lower()
            for record in historical:
                self.assertNotIn(record['id'], text)
                tweet = record['state']['post']['text']
                if len(tweet) > 45:
                    self.assertNotIn(tweet.lower(), text)


if __name__ == '__main__':
    unittest.main()
