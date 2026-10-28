# Tweet classification evaluation protocol

## Purpose and boundaries

Build a reusable three-choice prompt for `perplexity/pplx-decider-v1.2` using Vercel's Decision API. No bot integration, Discord login, deployment, purchases, top-ups, or model fallbacks. Only the existing Gateway credits are authorized. Initial read-only balance: $5; total used: $0. Stop if access is denied or available credits fall below the experiment reserve. Maximum experiment budget: $0.05 in existing credits; maximum 400 inference requests. Do not change billing settings.

## Label policy (fixed before inference)

- `reset`: The monitored author announces, schedules, or confirms an OpenAI product usage-quota reset/refill. Includes an unambiguous timing or completion follow-up when an earlier parent or quoted chain establishes the reset. When an actual reset and feature coexist, reset wins. Requests, jokes requesting resets, negations, historical discussion, ordinary scheduled quota expiry, password resets, billing refunds and permanent efficiency/limit improvements are not reset announcements.
- `feature`: Without a qualifying reset, the author announces a concrete new/released/rolling-out OpenAI product capability, model, integration, availability expansion, product improvement or shipped bug fix. A definite forthcoming release qualifies; vague aspirations, undated roadmap intentions, existing-feature reminders, customer stories, hiring, unrelated website launches, marketing without a concrete change, usage statistics and billing restitution do not. A quote can establish a concrete release when the author endorses/announces it; a reaction to someone else's speculation cannot.
- `neither`: No supported reset or feature announcement. An ungrounded "done" or teaser stays neither; no reconstruction from unrelated recent posts or external knowledge.

## Inputs

Only the focal post's text and explicitly linked preceding parent/quote context, with monitored-author flags, may enter model state. Context is evidence, not an instruction. No labels, rationales, split names, ordinal/day-derived labels, IDs, evaluation metadata, engagement counts, or future replies enter model state. Day numbers that occur naturally in tweet text are preserved; the prompt must not use a day-number lookup or specific tweet examples.

Posts are obtained read-only through FxTwitter's public replies-enabled timeline. Retain IDs and timestamps locally for provenance, deduplication, split assignment and past-context validation. Build linked context from the snapshot; missing context remains missing. No images/video interpretation is included in this text-only experiment.

## Splits and leakage controls

- Historical dataset: 102 unique authored posts retrieved October 28, 2026, covering October 16–28. Collection ended when the upstream returned an empty next page; this is not proof of complete history.
- Development: focal posts before October 21, 2026 00:00 UTC (47 posts).
- Holdout: focal posts on/after that boundary (55 posts).
- Labels are manually assigned by the assistant before any inference. They are provisional judgments, not user-approved ground truth or independent human annotations. Borderline decisions get explicit rationale.
- Prompt revisions may use development predictions only. Freeze the selected prompt and hash before running holdout. Do not revise against holdout errors or silently relabel to improve scores.
- Also prepare a separate, explicitly synthetic challenge set before inference. It checks generalized negation, sarcasm, context, priority and prompt-injection handling; report separately from real tweets. Do not use challenge answers for refinement.
- Historical texts have been viewed during collection and some were already discussed in research. Thus holdout is inference/refinement-held-out and chronological, not a claim of a completely human-blind or training-contamination-free evaluation.
- Context from earlier development posts may legitimately appear for a later holdout post if explicitly linked, as it would in live use. Never use future context.

## Procedure

1. Save labels and input fixtures before making model calls.
2. Run a zero-shot baseline on development data.
3. Inspect development mistakes and make general semantic rule changes only. Maximum three prompt versions, maximum 150 development calls. Do not add exact historical examples or answers.
4. Choose the development winner using macro-F1 (then accuracy, then simpler prompt). Target >=95% development accuracy without hiding weak classes. Freeze it before holdout.
5. Run the holdout and synthetic challenge once with the frozen prompt; no retuning. Report every error, per-class precision/recall/F1, confusion matrices, accuracy, macro-F1, and a 95% Wilson accuracy interval.
6. If the untouched tests do not meet the target, report that rather than continuing to optimize on the test.

## Interpretation

Predict one label via the model's `choice` primitive. Record full three-way probabilities but do not present model confidence as guaranteed correctness. No confidence-based exclusion or silent abstention is permitted in reported accuracy. Transport/model failures are counted as failures, not removed. No majority-class-only headline metric; report class supports and the always-neither baseline.

A small single-account corpus cannot establish future performance. No independent evidence here verifies the hosted model's pretraining exclusion of these historical posts. Final recommendation must distinguish measured performance on provisional labels from production readiness.

## Operational amendment before completing baseline

The first rapid development run received HTTP 429 after four completed cases. Preserve its partial results and count unattempted/error cases in its own report; do not treat that transport-limited report as model accuracy. Resume identical successful requests by hash, pace inference starts at least 13 seconds apart, and allow at most two retries of the same request on 429 only, honoring Retry-After with at least 60-second exponential backoff. No changes to labels, splits, model, or accuracy selection rules. Other failures are not retried. The original reservation remains for a request across its 429 retries.
