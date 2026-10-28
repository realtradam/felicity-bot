# Challenge-scoped update policy — user clarification

This is a **requirements change**, not another attempt to improve the old generic-feature benchmark score. The user clarified that `feature` specifically means an update in @thsottiaux's daily **ship an improvement or reset** challenge. Usage resets qualify **whether or not they belong to the challenge**.

## Historical evidence

- [Original challenge announcement](https://x.com/thsottiaux/status/2106845241357824205): “Over the next 28 days, each day we’ll either ship one thing that is a clear improvement and relevant for most codex/work users or ship a full reset.” Verified with a free public source GET during this revision.
- [Numbered improvement entry](https://x.com/thsottiaux/status/2111244596131111253): Day 12 announces usage-efficiency improvements. Its direct announcing follow-ups also belong to the entry.
- [Specific follow-up](https://x.com/thsottiaux/status/2113770862860222611): CLI improvements reply directly to the author's numbered Day 19 update, so a focal post does not itself need a day number.
- [Standalone slides release](https://x.com/thsottiaux/status/2111249810502353152): a concrete release but supplied links contain no challenge connection. Under the clarified conservative policy it is `neither`, unlike the old generic-feature label. Verified with a free public source GET.
- [Improvements AND reset](https://x.com/thsottiaux/status/2113492187770175603): Day 18 lists several improvements then says “But yes… that’s a reset!” Both can happen; reset wins.
- [Joking update retracted](https://x.com/thsottiaux/status/2115273064481218829): Day 23 starts with plugins, then “Just kidding, today is a reset.” Verified with a free public source GET.
- [Standalone reset](https://x.com/thsottiaux/status/2105843926221660585): global reset announcement without a day marker. Must still notify.

## Revised general rules

1. `reset`: any actual announcement, scheduling or confirmation of an OpenAI product usage reset/refill/restoration, including a subset of users and linked timing/completion posts. No challenge/day marker required. Preserve the existing exclusions for requests, negations, ordinary historical commentary, account/device/password resets and billing refunds. Reset takes priority if both happen.
2. `feature`: a concrete improvement or daily improvement roundup presented as part of the daily challenge, with no actual reset announced in the focal post. Evidence may be in the focal post or explicitly linked earlier context. Day labels are evidence of framing, **not** a map from numbers to answers. An announcing follow-up can qualify; mere advice, votes, reactions or clarifications do not inherit the parent's category.
3. `neither`: generic release news without an established challenge connection and all other unsupported/unrelated content. Do not infer a connection merely because a post is recent, from the same author, or about Codex. Challenge rules/conditional reset promises are not actual reset announcements.

Missing linkage can reduce update recall; this is intentional conservatism, not a claimed perfect detector. No dates, IDs, past answers or specific examples are put in the prompt. Text-only linked context remains the input; no unrelated same-day history is injected.

## Notification meaning

- 🎉 **OpenAI usage reset**
- 🥀 **OpenAI challenge update**, followed by **“No reset announced in this post.”**

An update is not proof that no reset will follow later the same day. A later actual reset still gets its own notification; no per-day latch suppresses it. Unrelated posts remain silent.

`!test openai-reset` now replays a stored real historical reset through the exact live formatter, without test labels. Its source post and recorded v3 confidence are local constants from `historical.json` and `phase2-development-v3.jsonl` (Day 21 post, reset probability 0.8848731585381278). This is a historical replay, not a new inference or fresh announcement. It does not call Twitter/Gateway, register, or enter the monitor queue. The preview fixture is used only for rendering, never as classifier state, few-shot examples or lookup rules.

## Evaluation integrity and status

- The prior v3 prompt, `prompt-final.json`, frozen hashes, original labels, predictions and reports remain unchanged. Their metrics apply to the **old broader policy**, not this revision.
- `prompt-v4-challenge.json` is the explicit new-policy prompt. Runtime parity checks now target it. The earlier phase-2 “no v4” rule remains the boundary for its old evaluation: this new file exists because the **user changed the category definition**, not because old test mistakes were used for another hidden tuning round.
- `challenge-scope-cases.json` has 32 provisional policy cases: 22 already-seen historical cases and 10 synthetic cases. Old expected labels are preserved beside new labels where applicable; they are not overwritten to improve predictions. These are regression/annotation cases, **not unseen validation**.
- `frozen-challenge-scope.json` records the prompt and fixture hashes before any future scope-model inference.
- **No new model inference was performed for this change. No accuracy, including reset accuracy, has been measured for v4.** Offline tests verify plumbing, prompt parity, fixture separation, display and priority/fan-out behavior; they do not prove model classifications. A future explicitly executed evaluation must report real model results separately and retain all failures. More independent future tweets are needed for a credible accuracy estimate.
- No live Discord process, production mutation, purchase, top-up, paid-tier change or fallback model was used.

## Reproduction

```sh
python3 -m unittest discover -s research/tweet-classifier -p 'test_*.py' -v
# Dry-run; does not read credentials or call an API:
python3 research/tweet-classifier/evaluate.py --split scope \
  --prompt prompt-v4-challenge.json --output scope-v4.jsonl
```

Do not add `--execute` without authorization to consume existing credits. The same fixed model, rate pacing, conservative reservations and prior experiment caps still apply; there is no billing/purchase path.
