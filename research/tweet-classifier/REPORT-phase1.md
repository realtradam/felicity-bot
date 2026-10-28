# Reset / feature / neither: decision-prompt evaluation

## Summary

Model: **`perplexity/pplx-decider-v1.2`**. Selected zero-shot prompt: **prompt-v2.json**.
No examples, answer keys, tweet-ID rules or day-number lookups are included in the prompt.
This is a standalone research experiment; no bot integration or deployment was performed.

## Measured results

| Run                  | Correct / cases | Accuracy | Macro-F1 | Always-neither accuracy |
| -------------------- | --------------- | -------- | -------- | ----------------------- |
| development-v1-paced | 41/47           | 87.2%    | 0.605    | 83.0%                   |
| development-v2       | 46/47           | 97.9%    | 0.965    | 83.0%                   |
| holdout              | 45/55           | 81.8%    | 0.651    | 72.7%                   |
| challenge            | 36/36           | 100.0%   | 1.000    | 33.3%                   |

Accuracy includes transport errors as wrong. Macro-F1 gives each class equal weight.
Do not combine development accuracy with test accuracy to claim generalization.

### development-v1-paced

95% Wilson accuracy interval: 74.8%–94.0%.

| Class   | Support | Precision | Recall | F1    |
| ------- | ------- | --------- | ------ | ----- |
| reset   | 3       | 0.0%      | 0.0%   | 0.000 |
| feature | 5       | 100.0%    | 80.0%  | 0.889 |
| neither | 39      | 90.2%     | 94.9%  | 0.925 |

Confusion matrix (rows = true, columns = predicted):

| True    | reset | feature | neither | error |
| ------- | ----- | ------- | ------- | ----- |
| reset   | 0     | 0       | 3       | 0     |
| feature | 0     | 4       | 1       | 0     |
| neither | 1     | 0       | 37      | 1     |

Errors:

- **feature → neither** ([source](https://x.com/thsottiaux/status/2111245052513259606)): And update your app to enjoy this gem https://x.com/Gavmn/status/2111136119945396436
  - Provisional label rationale: Endorses a concrete home-screen release in the quoted post.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2111492673890824348)): Day 13/ Le limit reset
  - Provisional label rationale: Explicit quota reset or linked timing.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2111492738025959922)): Landing sometime today by EOD PST
  - Provisional label rationale: Explicit quota reset or linked timing.
- **neither → error** ([source](https://x.com/thsottiaux/status/2111832959842161136)): @argofowl EU sorry. We’re making it so that (a) if you had created a dot elsewhere and find yourself in the EU it will keep working (b) dots are coming to the EU in the future
  - Provisional label rationale: Undated in-progress regional roadmap, not an available or definite scheduled release.
  - Transport/validation error: URLError
- **reset → neither** ([source](https://x.com/thsottiaux/status/2112432076767289678)): Day 15/ Nevermind, we're still cooking... and reset. Enjoy.
  - Provisional label rationale: Explicit quota reset or linked timing.
- **neither → reset** ([source](https://x.com/thsottiaux/status/2112592264686149749)): There were reports of usage draining faster than anticipated for some users over the weekend. We've identified approximately 40,000 accounts that had an inconsistency on which usage limits where the actual usage that was applied did not correspond to their actual selected plan. We are reaching out individually to all these users and have corrected the issue. If this affected you, we'll add credits to your account. Sorry we got this wrong.
  - Provisional label rationale: Billing/plan correction and restitution, not product feature or quota reset announcement.

### development-v2

95% Wilson accuracy interval: 88.9%–99.6%.

| Class   | Support | Precision | Recall | F1    |
| ------- | ------- | --------- | ------ | ----- |
| reset   | 3       | 100.0%    | 100.0% | 1.000 |
| feature | 5       | 83.3%     | 100.0% | 0.909 |
| neither | 39      | 100.0%    | 97.4%  | 0.987 |

Confusion matrix (rows = true, columns = predicted):

| True    | reset | feature | neither | error |
| ------- | ----- | ------- | ------- | ----- |
| reset   | 3     | 0       | 0       | 0     |
| feature | 0     | 5       | 0       | 0     |
| neither | 0     | 1       | 38      | 0     |

Errors:

- **neither → feature** ([source](https://x.com/thsottiaux/status/2111832959842161136)): @argofowl EU sorry. We’re making it so that (a) if you had created a dot elsewhere and find yourself in the EU it will keep working (b) dots are coming to the EU in the future
  - Provisional label rationale: Undated in-progress regional roadmap, not an available or definite scheduled release.

### holdout

95% Wilson accuracy interval: 69.7%–89.8%.

| Class   | Support | Precision | Recall | F1    |
| ------- | ------- | --------- | ------ | ----- |
| reset   | 11      | 100.0%    | 9.1%   | 0.167 |
| feature | 4       | 80.0%     | 100.0% | 0.889 |
| neither | 40      | 81.6%     | 100.0% | 0.899 |

Confusion matrix (rows = true, columns = predicted):

| True    | reset | feature | neither | error |
| ------- | ----- | ------- | ------- | ----- |
| reset   | 1     | 1       | 9       | 0     |
| feature | 0     | 4       | 0       | 0     |
| neither | 0     | 0       | 40      | 0     |

Errors:

- **reset → neither** ([source](https://x.com/thsottiaux/status/2113162413008884099)): Lands tomorrow before 10am PST.
  - Provisional label rationale: Explicit quota reset or linked timing.
- **reset → feature** ([source](https://x.com/thsottiaux/status/2113492187770175603)): Day 18/ Decisions API is GA, OpenResponses joined the Linux Foundation, we shipped some performance improvements and Uber is going all-in on codex & work. But yes… that’s a reset!
  - Provisional label rationale: Real reset takes priority over multiple simultaneous feature announcements.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2113492502355562875)): Landing tomorrow before 10am PST together with a small ship.
  - Provisional label rationale: Explicit quota reset or linked timing.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2114200152701575656)): Day 20/ Rest and reset
  - Provisional label rationale: Explicit quota reset or linked timing.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2114200291319124163)): By midnight PST
  - Provisional label rationale: Explicit quota reset or linked timing.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2114237083652882932)): It is all propagated. Enjoy some mad codexing tomorrow. Fun week ahead too.
  - Provisional label rationale: Confirms propagation; explicit quote-to-parent chain establishes quota reset.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2114588174249071102)): Day 21/ Wonder what happens the remaining seven days. But today is a reset.
  - Provisional label rationale: Explicit quota reset or linked timing.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2115273064481218829)): Day 23/ Much requested iCloud Main & Calendar plugins. Just kidding, today is a reset. Still much requested though!
  - Provisional label rationale: Author retracts feature framing and explicitly announces reset; reset wins.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2115273253711409208)): Lands by midnight PST.
  - Provisional label rationale: Explicit quota reset or linked timing.
- **reset → neither** ([source](https://x.com/thsottiaux/status/2115330127886463244)): And it's done. See you tomorrow for some good news.
  - Provisional label rationale: Confirmation linked by quote and its parent to a reset; vague future teaser adds nothing.

### challenge

95% Wilson accuracy interval: 90.4%–100.0%.

| Class   | Support | Precision | Recall | F1    |
| ------- | ------- | --------- | ------ | ----- |
| reset   | 12      | 100.0%    | 100.0% | 1.000 |
| feature | 12      | 100.0%    | 100.0% | 1.000 |
| neither | 12      | 100.0%    | 100.0% | 1.000 |

Confusion matrix (rows = true, columns = predicted):

| True    | reset | feature | neither | error |
| ------- | ----- | ------- | ------- | ----- |
| reset   | 12    | 0       | 0       | 0     |
| feature | 0     | 12      | 0       | 0     |
| neither | 0     | 0       | 12      | 0     |

Errors:

- None on this saved run.

## Rules and refinement

- Version 1: short generic zero-shot classifier.
- Version 2: explicit account/product context; shorthand reset announcements; grounded timing/completion; endorsed quote releases; exclusion of billing restitution and existing-plan reminders. These changes were based only on development errors and preserve the original label policy.
- Version 3: see revision notes in `refinement.md`; created from development errors only.
- Final prompt frozen at 2026-10-28T11:00:56.457188+00:00; SHA-256 `a6798ca23b6ff15eaef3c022417f2a552488711c3bab55c83d2a721959edfbd3`.
- Holdout and synthetic challenge were run only after that freeze. No prompt changes after test inspection.

## Validity and limitations

- Historical corpus: 102 authored posts from one account, October 16–28, 2026, obtained through FxTwitter. The upstream stopped returning older pages; completeness is not established.
- Chronological split: 47 development posts before October 21; 55 later holdout posts. Holdout contains only 11 reset and 4 feature cases, so per-class estimates are particularly uncertain.
- Labels were assigned by this assistant before inference, not by an independent annotator or the user. Reported accuracy means agreement with this explicit provisional policy, not objective truth.
- All texts were visible during dataset collection; holdout is held out from model-guided refinement, not claimed to be blind to the assistant. Model training contamination cannot be excluded.
- Context includes only explicitly linked preceding text. No future replies, labels, rationales, splits, engagement statistics or evaluation metadata enter inference state. Text-only inputs miss image/video-only announcements.
- Reset takes priority when both are announced. New shipped fixes/efficiency changes count as feature; old-feature reminders, vague undated plans, billing restitution and unrelated launches count as neither.
- The synthetic challenge set is an artificial rule-oriented check, not representative observed traffic. Its cases and labels were fixed before inference and never used for refinement.
- Repeated author wording and related posts reduce effective sample size. Wilson intervals assume independent cases and can therefore be optimistic here.
- Model probabilities were recorded, not assumed to be calibrated. No threshold excluded difficult cases from scoring.
- Prompt classification does not implement notification deduplication: an announcement, timing follow-up and completion can each be reset. Event-level deduplication remains a separate integration task.

## Costs and operations

- Sum of completed-request costs recorded in ledger: **$0.00230708** from existing Gateway credits.
- An initial rapid baseline hit HTTP 429. Its partial report is retained separately; paced baseline reused only identical successful requests verified by prompt and dataset hashes.
- Paced requests start at least 13 seconds apart, with bounded 429 backoff. No billing changes, top-ups, new subscriptions, Discord login or live bot mutations.
- The ledger conservatively reserves budget for requests without a reported cost, including network failures. Gateway balance deltas in each summary can differ from summed costs because reporting is asynchronous.

## Files and reproduction

- `prompt-final.json`: deployable single-choice question object. Supply actual post/context separately as state.
- `PROMPT.md`: human-readable prompt and allowed input/output contract.
- `protocol.md`: pre-inference label policy, split and selection rules.
- `historical.json`, `challenges.json`: fixtures with labels/rationales kept outside model state.
- `*.jsonl`, `*.summary.json`, `ledger.jsonl`: raw predictions, metrics and experiment cost trail.
- `evaluate.py`: standalone evaluation; dry-run by default, explicit `--execute` required for inference.
- Offline checks: `python3 -m unittest discover -s research/tweet-classifier -p "test_*.py" -v`.
- Dry run: `python3 research/tweet-classifier/evaluate.py --split holdout --prompt prompt-final.json --output verification.jsonl`.
- Executing a rerun consumes existing credits. Do not rerun until authorized; never tune against the saved holdout.
- Fixture regeneration requires the original read-only collection snapshot under `/tmp/felicity-tweet-research`; the committed normalized fixtures are sufficient to reproduce inference without recollecting tweets.

## Sources

- [FxTwitter public timeline API](https://docs.fxembed.com/api/twitter/operations/2profilehandlestatuses/)
- [Vercel Decision API](https://vercel.com/docs/ai-gateway/capabilities/evaluation)
- [Vercel model eligibility endpoint](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)
- [Vercel rate limits](https://vercel.com/docs/ai-gateway/rate-limits)
