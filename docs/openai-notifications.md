# OpenAI reset / feature notifications

Implementation status: implemented and offline-tested; **not deployed or live-smoke-tested** by this change. Do not start another Discord-connected instance to test it with the shared production token. Follow [AGENTS.md](../AGENTS.md).

## Channel commands

```text
!register openai-reset
!unregister openai-reset
!unregister
!test openai-reset
```

- Register subscribes the **current channel** to both usage-reset and feature announcements from **@thsottiaux**. Despite its name, the `openai-reset` topic includes both. `neither` produces no message.
- The bot accepts server text/announcement channels and active, unlocked threads where it has View Channel and Send Messages (Send Messages in Threads for threads). It does not change channel permissions or reopen archived threads.
- Repeating register is idempotent. Subscriptions persist across restarts, are isolated by server/channel, and are removed on channel/server deletion. Unregister removes only the current channel, including unsent queued deliveries. Bare `!unregister` is an alias for this one topic.
- New subscribers receive posts published from registration time onward, not a historical dump. Re-registering starts a new subscription. Registration timestamps use the source's one-second precision.
- **`!test openai-reset` only replies with a built-in synthetic sample**, including an explicitly labeled example confidence of 97.4%. It makes **zero Twitter/FxTwitter or AI/Gateway calls**, spends no credits, does not register the channel, and works with monitoring disabled or no Gateway key. Discord still has to send the reply.
- Unknown topics or extra arguments return usage guidance. `!help` lists these commands. Commands have no caller-role/permission gates, consistent with the rest of this bot; Discord still enforces the bot's own permissions. Bot/webhook/DM messages are ignored by the dispatcher.

Example real-notification shape (text here is illustrative):

```text
OpenAI usage reset
AI confidence: 96.7% (model estimate)

> The source post’s announcement text

@thsottiaux · https://x.com/thsottiaux/status/<post-id>
```

Feature announcements use “OpenAI feature update”. Confidence is the **chosen category's probability returned by the Decision API**, not a fixed value or an invented explanation. It is not a measured accuracy or a guarantee. The actual notification includes the canonical source link and, when available, a short earlier-context excerpt. Long text is bounded to Discord's message limit, markdown is escaped, and mentions are disabled.

## Source, classification and timing

- No X API subscription, cookies, user account or X credentials. The adapter polls the free **FxTwitter v2** profile endpoint every **60 seconds** while there are subscribers: `https://api.fxtwitter.com/2/profile/thsottiaux/statuses?with_replies=true&count=100`.
- This is polling, **not a real-time stream**. Upstream caching and outages add delay; expected delivery is on a minutes timescale, not guaranteed at tweet publication. FxTwitter is third-party/unofficial and can break or limit access. Review applicable service terms; there is no uptime or completeness guarantee.
- Candidate authorship must match the monitored numeric account ID **and** handle. Other authors, pure reposts and nested quoted posts are not treated as independent announcements. Replies by the monitored author can qualify.
- Context consists only of explicitly linked earlier parents/quotes, at most three hops and six text entries; no future thread replies, OCR, media understanding, arbitrary URL fetching or article crawling. Missing required linked context causes a retry, not a confident guess without it.
- Timeline catch-up is bounded to five pages per poll; context lookups to six per fetch, cached in memory across retries (1,000 statuses). A page/lookup-budget failure retains the checkpoint and retries; context progress can accumulate. Fully contextualized posts from a partially resolved batch can proceed while the unresolved gap remains, so one deleted parent does not suppress every other notification. A very long downtime exceeding five accessible pages needs operator investigation rather than silently skipping an unproven gap. A five-minute overlap absorbs modest source caching/out-of-order arrivals, but cannot guarantee discovery of posts exposed later than that window or posts the source never returns.
- Classification uses only **`perplexity/pplx-decider-v1.2`**, the previously tested non-Flash Decision model, and the unchanged frozen **v3** prompt. No keyword fallback, alternate model, historical answer lookup or threshold tuned to hide errors. Runtime prompt parity is covered by an offline test.
- Reset wins over a simultaneous feature announcement. Otherwise a specific feature/release/improvement is `feature`; unrelated/unsupported content is `neither`. Every valid reset/feature decision is delivered regardless of confidence; the displayed confidence helps the reader interpret it without silently filtering possible resets.
- One serial worker classifies each newly observed post **once for all channels**, then fans out the result. Starts are paced at least 13 seconds apart, approximately five per minute, with persistent rate-limit deadlines and Retry-After/backoff. This is a conservative rate inferred from testing, not a contractual account quota.
- The research's fresh retrospective validation had **10/10 resets correct**, **44/52 overall (84.6%)**. Feature precision was **58.8%** and recall **90.9%**; neither recall **77.4%**. These are small, assistant-labeled samples, not a promise of 100% future reset detection. Earlier development misses are retained in the [full report](../research/tweet-classifier/REPORT.md).

## Existing credits only; fail closed

Supply **one existing free-tier AI Gateway credential** via `AI_GATEWAY_API_KEY`, or the existing repository convention `VERCEL_TOKEN`. If both are nonempty, `AI_GATEWAY_API_KEY` takes precedence. Never commit/paste the value. Both Compose files pass these optional values into the bot. The local `.env` is not automatically sent to Dokploy.

`OPENAI_RESET_ENABLED` defaults to `true`, but the monitor runs only with a nonempty key. Set it to `false` to stop monitoring without removing subscriptions or the offline test command. Register still saves subscriptions while disabled and warns that monitoring is off.

Before **every** inference, read-only Gateway model/credit checks must confirm:

- The exact fixed model is eligible, HTTP account access is available, input pricing is at most **$0.02/million tokens**, and output pricing is zero.
- Existing balance is at least **$0.10**, and the account's reported total usage is at most **$4.99**, a conservative ceiling against the original $5 free allocation.
- A persisted **$0.05 lifetime per-notifications-database budget** has room for a **$0.0005 reservation**. Each successful request settles to its reported cost, rounded up to a microdollar. Unknown/failed/ambiguous requests keep their full reservation.

No billing/purchase/top-up API, model fallback or paid-tier upgrade is implemented. If access, price, schema, credits or budget checks fail, inference pauses/retries without an announcement. Request bodies are capped at 18,000 UTF-8 bytes rather than silently truncating the input. For the no-new-money requirement, keep **auto-recharge disabled in the Gateway account** and use the known existing free-tier key: the API's balance field itself does not prove where credits came from. These guards constrain this bot, not other consumers of the same account, account-wide races, or upstream billing changes. Do not delete/reset the accounting to bypass a stopped budget without explicit authorization. Rebuilding/redeploying preserves it in the volume.

No new inference was required for implementation/tests; all test transports are fakes. Read-only source/catalog shape checks do not consume inference credits.

## Persistence, retries and operations

`DATA_DIR/notifications.sqlite` (separate schema **1**) holds subscriptions, observed post queue, classifications/confidence, per-channel delivery journal, checkpoint, retry deadlines and conservative credit usage. The existing emoji/history database remains schema **5** and is not migrated by this feature. Both live in the existing bot data volume; no new volume/service or dependency was added. Do not merge production and dev databases. The stopped full-directory `bin/data-backup` already includes both databases and their WAL sidecars.

- HTTP requests use fixed HTTPS hosts, refuse redirects, limit response sizes and use timeouts/abort signals. Keys, raw errors, bodies and headers are not logged.
- Classification failures stay queued with bounded backoff rather than being marked `neither`; already queued work can proceed through a timeline-source outage. Failures are visible in bot logs but do not change the existing Discord-readiness health check.
- A durable delivery journal prevents the same post being resent on normal polls or restarts. **Deduplication is per post ID**, not inferred event: separate announcement/timing/completion posts about the same reset may each notify. The bot does not promise event merging or exactly-once distributed delivery.
- Before sending, the worker claims the delivery and the Discord adapter rechecks the subscription after async lookups. Unregister cancels unsent queued work; a Discord send already in flight cannot be retracted.
- A send error/crash can be ambiguous. The journal records `uncertain` (startup recovery changes interrupted `sending` to `uncertain`) and deliberately does **not** blindly retry it, avoiding duplicate spam at the cost of potentially missing a notification. Other channels continue. Inspect the channel and logs before any authorized manual recovery. Missing permissions/archived threads also need operator action; there is no permission-escalation workaround.
- Completed post/delivery records are pruned after 30 days; live unclassified work and pending deliveries remain. Subscriptions, checkpoints, rate deadlines and credit accounting do not expire. There are no Discord-message cleanup/deletion jobs.
- Shutdown aborts polling/inference, waits for tracked work, and closes storage. Non-root runtime and the 30-second Docker grace period are unchanged.

Deployment is a separate authorized operation. Add the existing key securely to the production environment when deploying if it is not there; do not log a second bot in to test. The safe first live check after authorized deployment is `!test openai-reset`, then registration in the intended channel. No user data/production state was changed during offline implementation.

## Offline verification

```sh
./bin/test
./bin/check
./bin/build
./bin/validate-compose
./bin/secret-check
```

These scripts use no-dependency containers and do not log the bot into Discord. Test suites cover durable registration/dedup/recovery, actual prefix-command dispatch, offline preview with networking explicitly forbidden, chosen-class confidence, source filtering/pagination/context, API eligibility/price/credits/rate/budget guards, cancellation, retry behavior and multi-channel isolation.
