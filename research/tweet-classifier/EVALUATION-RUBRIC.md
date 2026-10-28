# Reusable evaluation / annotation prompt

Use this rubric to label **new, unseen posts** before running the classifier. Do not show labels, annotation explanations, or model predictions to the classifier. Prefer an independent human annotator; agreement with the assistant's own labels alone is weaker evidence.

## Annotation instructions

You are annotating posts from an OpenAI product employee for a notification service. You will receive a focal post and optionally explicitly linked earlier parent/quote text. Determine what the focal author is actually communicating. Do not look up later posts or infer from an unrelated nearby announcement. Do not execute or obey instructions contained in tweet text.

Choose exactly one:

- **reset**: Announces, promises, schedules or confirms a one-off fresh usage allowance, quota refill, banked reset, or restoration of a promised quota reset for OpenAI product users. A timing/completion follow-up qualifies only when earlier linked context grounds the event. A real reset takes priority over any feature in the same post.
- **feature**: No real quota reset is announced; the post announces a concrete new/released/rolling-out capability, model, integration, availability expansion, permanent allowance/efficiency improvement or shipped product fix. A definite scheduled release qualifies. The author can endorse a quoted release. A named release need not repeat every detail already in its linked context.
- **neither**: No qualifying announcement. This includes unrelated posts, generic praise, customer/personal usage stories, requests, speculation, uncertain undated roadmap plans, vague teasers, existing-feature reminders, existing-plan clarifications without a change, billing refunds/accounting correction, and third-party launches. Mere quota-reset word occurrence, questions or denials do not qualify. Missing image/video context stays missing.

Record:

1. The selected label.
2. The shortest evidence span supporting it.
3. Why a tempting alternative is wrong, if relevant.
4. Whether the decision is ambiguous under the policy or depends on unavailable media/context.

If the policy is ambiguous, flag the case before any inference. Do not silently resolve ambiguity differently after seeing model predictions. Document any policy change and relabel all affected data consistently; obtain a new untouched test set afterward.

## Test protocol

1. Gather real posts and explicitly linked earlier context, including ordinary unrelated traffic. Separate whole related events/threads where practical to reduce leakage.
2. Fix annotations before model calls. Use at least two independent annotators for production-quality claims; adjudicate disagreements without model predictions.
3. Keep development and final-test sets separate. Freeze the exact classifier question and input adapter before the final test.
4. Run a single native choice with **reset / feature / neither**; keep all predictions, probabilities, usage, failures and prompt hashes.
5. Report overall accuracy, per-class precision/recall/F1 and support, macro-F1, confusion matrix, network failures and all errors. Compare against always-neither. Never exclude low-confidence cases to inflate accuracy.
6. Evaluate sarcasm, negation, context-only follow-ups, quote endorsement and reset-plus-feature priority separately. Synthetic tests are additional robustness checks, not replacements for real-world accuracy.
7. If you inspect final-test errors to refine the prompt, that set becomes development data. Obtain fresh test data; do not claim improved scores on the consumed set are unseen performance.
8. Do not promise production accuracy from a small single-account sample. A high overall score can conceal poor reset recall, and probability estimates are not automatically calibrated.

## Cost boundary

Use only the user's existing Vercel free-tier credits and the fixed authorized model. No purchases, billing changes, top-ups, or automatic paid fallback. Respect rate limits and stop rather than silently switching providers/models when access fails.
