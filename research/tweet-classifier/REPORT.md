# Reset / feature / neither: final research results

## Bottom line

Final candidate: **`prompt-v3.json`**, model **`perplexity/pplx-decider-v1.2`**.
New retrospective validation: **44/52 (84.6%)**, macro-F1 **0.857**.
This is a small single-account experiment with assistant-assigned provisional labels, not proof of future or production accuracy. No bot integration or deployment was performed.

## All iterations, including failed tests

| Run                               | Correct | Accuracy | Macro-F1 | Always-neither baseline |
| --------------------------------- | ------- | -------- | -------- | ----------------------- |
| v1 development                    | 41/47   | 87.2%    | 0.605    | 83.0%                   |
| v2 development                    | 46/47   | 97.9%    | 0.965    | 83.0%                   |
| v2 original chronological holdout | 45/55   | 81.8%    | 0.651    | 72.7%                   |
| v2 synthetic challenge            | 36/36   | 100.0%   | 1.000    | 33.3%                   |
| v3 consumed holdout → development | 52/55   | 94.5%    | 0.917    | 72.7%                   |
| v3 NEW retrospective validation   | 44/52   | 84.6%    | 0.857    | 59.6%                   |

### Why a second test set was necessary

The v2 prompt scored 97.9% on development but missed 10/11 reset posts in its original chronological holdout. Its 100% synthetic result did not rescue that failure. The consumed holdout was explicitly promoted to development; improved v3 scores there are **not unseen accuracy**. One shorter final revision was frozen before testing on a newly collected nonoverlapping sample of older posts. No v4 was created.

## Final validation details

95% Wilson accuracy interval: **72.5%–92.0%**. Related posts are not independent, so this interval can be optimistic.

| Class   | Support | Precision | Recall | F1    |
| ------- | ------- | --------- | ------ | ----- |
| reset   | 10      | 100.0%    | 100.0% | 1.000 |
| feature | 11      | 58.8%     | 90.9%  | 0.714 |
| neither | 31      | 96.0%     | 77.4%  | 0.857 |

Confusion matrix (rows = annotated, columns = predicted):

| True    | reset | feature | neither | error |
| ------- | ----- | ------- | ------- | ----- |
| reset   | 10    | 0       | 0       | 0     |
| feature | 0     | 10      | 1       | 0     |
| neither | 0     | 7       | 24      | 0     |

### New validation errors

- **neither → feature** ([post](https://x.com/thsottiaux/status/2100297380968997327)): Astra ✅ Fast ✅ Frontier ✅ Efficient ✅ For everyone
  - Label rationale: Praise of existing model benchmark results, not a new product release.
- **neither → feature** ([post](https://x.com/thsottiaux/status/2104989161774322009)): Dots are included in all Pro, Business Premium and Enterprise plans. This includes the Pro 100 plan. We’ll be looking to further expand access soon.
  - Label rationale: Existing plan inclusion clarification and vague future expansion.
- **neither → feature** ([post](https://x.com/thsottiaux/status/2104994835212226681)): Live demos suffered from rolling out all the updates at the same time, but were committed to keep doing these live in the future. Almost all the things we announced will be available today. Can’t see what you will do with it.
  - Label rationale: General launch-day recap with no specific capability established in linked text.
- **neither → feature** ([post](https://x.com/thsottiaux/status/2105007775676072381)): https://openai.com/index/introducing-gpt-6-1-sol/
  - Label rationale: No concrete new OpenAI feature or quota reset.
- **neither → feature** ([post](https://x.com/thsottiaux/status/2105039500149948878)): https://developers.openai.com/plugins/deploy/submission
  - Label rationale: No concrete new OpenAI feature or quota reset.
- **neither → feature** ([post](https://x.com/thsottiaux/status/2105102312167575701)): I got community noted, but the note is wrong 😅 Your primary dot is included in your plan and will be available 24/7. If you ask it to create a codex task for you, that one will be drawing usage as usual. But when your dot does work directly, that uses nothing and is all on top of your plans usage. In the future you will be able to increase the speed and allow your dot to have more bandwidth, this will be a paid feature, but the baseline functionality will always just be included in your plan.
  - Label rationale: Corrects misinformation about existing plan inclusions, not a new change.
- **feature → neither** ([post](https://x.com/thsottiaux/status/2107573405553938664)): Day 2.3/ Never worry about remembering what you were saying with that colleague. Just talk your heart out and build up the context to load up into codex to get it all done.
  - Label rationale: Concrete new OpenAI capability or shipped improvement.
- **neither → feature** ([post](https://x.com/thsottiaux/status/2110864861119045840)): Je programme en français
  - Label rationale: No concrete new OpenAI feature or quota reset.

### v3 development errors (already seen data)

- **neither → feature** ([post](https://x.com/thsottiaux/status/2113029854417600834)): Fully included in the Pro plan, doesn't draw on your weekly usage.
  - Label rationale: Existing plan inclusion clarification, without a stated change.
- **reset → neither** ([post](https://x.com/thsottiaux/status/2114200152701575656)): Day 20/ Rest and reset
  - Label rationale: Explicit quota reset or linked timing.
- **reset → neither** ([post](https://x.com/thsottiaux/status/2114237083652882932)): It is all propagated. Enjoy some mad codexing tomorrow. Fun week ahead too.
  - Label rationale: Confirms propagation; explicit quote-to-parent chain establishes quota reset.

## Anti-cheating / leakage controls

- No historical examples, known answers, tweet-ID lookups or day-number mappings in any prompt.
- All answer labels and rationales fixed before corresponding inference; none were changed to match predictions.
- Model request body includes only model ID, the general choice question and unlabeled post/context state.
- Context is explicitly linked earlier text only, at most three hops; no future thread replies.
- Final validation posts do not overlap the original 102 focal posts. Selection is every third chronological item from 154 independently collected older posts, producing 52 cases.
- v3 prompt and validation hashes frozen before any v3 predictions; no further prompt changes after validation inspection. Hashes in frozen-phase2.json.
- All predictions and errors retained; low-confidence answers are not excluded. Transport failures count as wrong. Synthetic and real results are never blended.

## Limits and assumptions

- Manual labels are this assistant’s provisional interpretation of protocol.md, not independent user-approved or multi-annotator ground truth. Borderline labels may need user adjudication.
- All text was visible to the assistant during collection. Held-out means not used for model-guided refinement; this is not a human-blind trial. Historical model-training contamination cannot be ruled out.
- The fresh test is older, retrospective traffic, NOT future chronological confirmation. Selection from the main timeline underrepresents ordinary standalone replies relative to the original set.
- Some posts depend on images or videos, which this text-only study does not interpret. A URL or ungrounded completion alone does not establish an announcement.
- A definite scheduled release counts as feature; vague undated intentions do not. Billing restitution is neither. A promised missing quota reset finally applied is reset. Reset wins when reset and feature coexist.
- A high probability does not guarantee correctness. No confidence thresholds were tuned to hide errors.
- Classification is not notification deduplication: reset timing/completion updates may need to update the existing notification rather than send another one.
- The original chronological holdout failure remains material evidence; do not market this as a 97.9% production classifier based on its development result.

## Existing-credit usage and safety

- Recorded successful inference cost across **all stages**: **$0.00339164** from the existing $5 balance.
- No purchases, top-ups, billing changes, paid-tier upgrades or model fallbacks. No Discord-connected process started; production and runtime data untouched.
- Approximately five requests/minute inferred from a 429 after the sixth rapid call; paced to starts at least 13 seconds apart. Bounded backoff respects 429 Retry-After.
- Maximum logical-call budget 400 and maximum existing-credit spend $0.05; unresolved request costs conservatively retain a reservation in ledger.jsonl.

## Saved artifacts

- **PROMPT.md / prompt-final.json**: final v3 classifier, readable and API-ready forms.
- **EVALUATION-RUBRIC.md**: reusable independent annotation and future-test instructions.
- **protocol.md / phase2-protocol.md**: fixed policy and explicit second-stage amendment.
- **refinement.md**: general changes and their reasons.
- **REPORT-phase1.md**: first-stage report, including failed chronological holdout. It predates second-stage results; its final-candidate references mean v2 at that time.
- **historical.json / validation.json / challenges.json**: fixtures and answer keys stored outside model state. _*frozen*.json_*: timestamped prompt/dataset hashes.
- **evaluate.py**: reproducible standalone harness, dry-run by default. No import or modification of live bot code.
- **_.jsonl / *.summary.json / ledger.jsonl*_: predictions, per-class metrics, errors and credit trail.

## Verification and reproduction

```sh
python3 -m unittest discover -s research/tweet-classifier -p "test_*.py" -v
# Dry-run only (does not spend credits):
python3 research/tweet-classifier/evaluate.py --split validation --phase2 \
  --prompt prompt-final.json --output new-validation-run.jsonl
```

Adding `--execute` consumes existing credits; do not rerun without authorization. Normalized fixtures are sufficient for reproducible inference. Collection scripts depend on original public-data snapshots under /tmp/felicity-tweet-research, which are not committed.

## Sources

- [FxTwitter timeline API](https://docs.fxembed.com/api/twitter/operations/2profilehandlestatuses/)
- [Vercel Decision API](https://vercel.com/docs/ai-gateway/capabilities/evaluation)
- [Vercel model availability](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api)
- [Vercel free-tier rate limits](https://vercel.com/docs/ai-gateway/rate-limits)
