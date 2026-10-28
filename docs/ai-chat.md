# Felicity AI chat and images

## Chat triggers and channel context

Put an actual Discord **@Felicity mention at the very start** of a message, then your text. Both Discord mention forms (`<@id>` and `<@!id>`) work. A mention in the middle, a leading space before it, ordinary channel chatter, and bot/webhook messages do not trigger chat.

Replying directly to **a Felicity AI text response** also triggers chat, without needing a mention. This uses persisted output-message IDs: replies to emoji reports, notifications, music panels, command acknowledgments, images and errors do not accidentally start chat. Every chunk of a long response is tracked. Reply references cannot import context from another channel. These commands are guild-only; DMs are not enabled.

History is shared by everyone in the **same channel**, not per user. Each thread is its own channel, separate from its parent and other threads. Only directed chat messages and completed AI responses enter the history; no background channel transcript or older Discord history is fetched. Directed user messages include their original UTC ISO timestamp, username and user ID. The system prompt identifies Felicity as a Discord bot and supplies the currently selected model's name and ID. Model changes retain channel history and update that prompt. The AI has exactly one optional tool: **`web_search` using Exa through Umans**, as in Dispatch. There are no other AI tools or Discord actions; it cannot operate emoji/music commands, run shell commands, access files, scrape pages, or generate images through a tool call. Image generation remains an explicit user command only.

The native **“Felicity is typing…”** indicator starts on the first nonempty streamed text/reasoning token **or tool-call start**, not while waiting for a provider response. It refreshes every eight seconds until generation completes/fails or shutdown begins. Reasoning is never displayed or stored. If needed for provider tool-call replay, it exists only in memory during the current turn. Discord owns the indicator text and expiry (about ten seconds); the API has no explicit “stop typing” action. Only the full **final assistant turn** is sent once generation completes; there are no partial-message edits. All text deltas in that final turn are concatenated, not just the last block. Intermediate text accompanying search calls, tool JSON and search results are not posted separately.

Responses contain the AI's text without a wrapper, followed by a final `-# <bare model display name>` line. If a router reports a different actual model, that model's display name is used when present in the catalog (otherwise its reported ID). Text longer than Discord's 2,000-character limit is split losslessly, without adding continuation labels or rewriting Markdown. The model footer appears on the last chunk. Markdown spanning a split may not render identically across separate Discord messages. Mentions and link previews are suppressed; model-generated mention syntax cannot ping members.

## Commands

All commands are ordinary public messages, available to everyone who can send messages in that channel. No caller role/permission gates are added.

| Command                    | Behavior                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `!ai help`                 | Explain chat and image commands, shared history and provider privacy.                     |
| `!ai models [page]`        | Chat-completion models only, eight per page; names, selection IDs, observed TTFT/TPS.     |
| `!ai model`                | Show this channel's current chat model ID.                                                |
| `!ai model glm-5.3`        | Set the channel's chat model (exact ID from the list).                                    |
| `!ai status`               | Show model choices and approximate history size.                                          |
| `!ai compact`              | Summarize older chat history, preserving recent turns where possible.                     |
| `!ai clear`                | Erase channel AI messages, summary and output-message reply tracking; keep model choices. |
| `!image models [page]`     | Only image-generation models, with observed average generation latency.                   |
| `!image model [model-id]`  | Show/set the channel's image model.                                                       |
| `!image <prompt>`          | Generate one image using that channel's image model.                                      |
| `!image generate <prompt>` | Explicit form if the prompt starts with `models`, `model`, `help` or `generate`.          |

Defaults: **GLM 5.3** (`glm-5.3`) for chat and **FLUX.1 Schnell** (`flux-1-schnell`) for images. Selection/listing fetches the authenticated Logfare catalog afresh, so account-access changes appear without a restart. Premium models are marked if training consent has not unlocked them; Felicity never changes the account's consent settings, signs up for services, tops up credits, or silently selects a different model when one is unavailable. Logfare's own router may route/fall back if explicitly selected.

Commands and inference are mutually exclusive within a channel. An overlapping request gets a busy reason instead of racing a clear/model change or mixing turn order. Other channels can operate independently. Requests have a four-minute overall deadline (catalog: 30 seconds; optional metrics: ten seconds) and abort on shutdown. There is no automatic request replay/retry or durable inference queue. Image generation does not enter chat history; image outputs do not trigger follow-up chat.

## Exa search — the only AI tool

`UMANS_API_KEY` enables `web_search`. Without this key no tools are offered, and the system prompt says so. Logfare remains the main chat/model provider; Umans is used **only as a search relay**, not as an alternative chat provider. No Firecrawl client, endpoint, fallback, scrape/crawl mode, URL-fetch parameter or other tool is exposed.

This follows Dispatch's `tool-web-search/src/backends/umans-backend.ts` protocol:

- Fixed endpoint: `https://api.code.umans.ai/v1/messages`.
- Auth headers: `x-api-key` and `Authorization: Bearer …`, using `UMANS_API_KEY` only.
- Fixed search provider header: `X-Umans-Websearch-Provider: exa`.
- Relay body: `model: umans-flash`, `max_tokens: 1024`, a single user message containing the search query, and `tools: [{ type: web_search_20250305, max_uses: 5 }]`.
- Only structured `web_search_tool_result` hits are retained (titles, URLs, snippets/page ages); relay prose is discarded. No actual URL is fetched by Felicity's search tool. Source URLs in results must be HTTP(S), without embedded credentials.

The main model receives a single OpenAI function definition named `web_search`, accepting only `query` (1–1,000 characters) and optional `limit` (1–10; default 5). The runtime validates the complete tool-call batch before any search is executed. Unknown names, unexpected parameters, duplicate/missing call IDs and malformed calls fail closed. At most **three search relay calls per reply** are allowed, each with a 60-second deadline; after that, the final model request has tools disabled. The whole chat/search loop has a four-minute deadline. The relay's server-side `max_uses: 5` is the Dispatch default per relay call, distinct from the bot's three-call cap.

For a search call, Felicity sends the assistant tool-call message and matching `role: tool` result back to Logfare, then resumes the same selected model. Results are marked untrusted, and the system prompt tells the model not to follow source instructions and to cite relevant URLs. There is **no** `send_message`/`respond` tool: a normal assistant turn without tool calls is the final response. Search arguments, results, intermediate prose and replay-only reasoning are ephemeral; only the original user message and final assistant text enter persistent channel history. History compaction never receives tools. Search failure/limits use the same bedtime response with a search-specific sanitized reason, never an alternative search backend.

Search queries go to Umans and its Exa backend. Do not put secrets in queries. Umans keys are never sent to Logfare or embedded in model prompts; Logfare keys are never sent to Umans. Search results may be included in the final answer and therefore local history, and the search-informed prompt/results are sent to Logfare like other context.

## Model speed metrics

The public [`GET /v1/status?hours=24`](https://logfare.ai/v1/status?hours=24) response includes `model_id`, `avg_ttft_ms`, `avg_tps` and `avg_latency_ms`. Chat listings join these by exact model ID and show **TTFT in seconds** and **TPS in tokens/second**. Image listings use latency instead. Values are Logfare's observed 24-hour averages, not measurements by Felicity or guaranteed performance for the next request. Null/missing values or an unavailable metrics endpoint show **unavailable**, never zero or invented estimates. Metrics failure does not prevent listing or selecting models. Audio, embeddings, decisions and video models are not listed.

## Compaction and persistence

`DATA_DIR/ai.sqlite` is a separate schema-1 SQLite database (WAL), with channel model settings, summary, completed text turns and reply IDs. It does not migrate/modify the emoji or notification databases. It lives in the existing bot data volume and survives restart. Backups of the whole data directory include it and its WAL sidecars. Protect those backups: unlike emoji analytics, **AI history contains directed message bodies, timestamps, usernames/user IDs and generated responses**. Runtime data is ignored by Git and must never be committed.

The auto-compaction threshold is **100,000 tokens**, including the system/history prompt. It uses `o200k_base` tokenization plus message overhead as a **cross-model estimate**, with provider-reported prompt usage as an additional trigger when available. It is not an exact tokenizer for GLM or every listed model. Smaller model contexts trigger earlier compaction with output/headroom reserved. A successful response crossing the threshold is followed immediately by compaction; the next request also checks before inference.

Compaction summarizes older turns and any existing summary into new historical context, normally retaining the last two complete turns. If those turns themselves are too large, they are summarized too. Oversize histories (including after switching to a smaller model) are summarized in bounded batches rather than silently truncated. Summaries are not promoted to trusted system instructions. Compaction is lossy by nature; use `!ai clear` for a genuinely fresh conversation. A failed/non-shrinking compaction preserves the original history. If background compaction fails after an answer was delivered, that answer is retained and the next request retries compaction before generating; if it still fails, the request receives the bedtime error rather than exceeding the context limit.

`!ai clear` also makes replies to old AI outputs inert unless a new leading mention is used. It does not delete public Discord messages, provider logs, backups, or model-training data. Deleting/editing a Discord message does not rewrite the AI transcript; use clear to forget it. Channel/thread deletion or leaving a guild removes its local AI records.

## Limits, errors and privacy

For a usage/rate limit (HTTP 429 or 402, or a streamed quota/rate-limit error), Felicity responds:

> I'm tired and went to bed. I can't reply right now.
> -# Usage limits reached

Other failures use the same sentence with a sanitized relevant subtext (authentication, access denied, unavailable model, service failure, timeout, interrupted/empty response, output limit, or compaction problem). Raw upstream errors, headers, request bodies and credentials are not sent to users or logs. Failed generations and error messages are not added to history or tracked as AI reply targets. Truncated or interrupted output is not presented as a complete answer.

Image results can be base64 or public HTTPS URLs. URL downloads reuse the existing DNS-pinned public-image downloader, validating every redirect without forwarding the API key. Private/local addresses, non-HTTPS links and custom ports are rejected. Bytes are limited to 8 MiB, 40 million pixels, and PNG/JPEG/WebP/GIF image formats before attaching to Discord. No image URLs, image data, or generated files are persisted by this feature.

Logfare advertises **free access with fair-use limits**, not a contractual unlimited quota. Its [homepage](https://logfare.ai/) says it logs prompts, completions and metadata, with scrubbed content potentially used for internal evaluation. Premium access may require model-training opt-in. The account owner manages consent at Logfare; this bot never changes it. Tell channel members about this before using it for sensitive conversations. Clearing local history cannot erase provider-held data.

## Configuration and verification

Supply `LOGFARE_API_KEY` through the ignored local `.env` or Dokploy environment. `AI_CHAT_ENABLED=false` disables AI chat and images; without a nonempty key they are disabled automatically. Both Compose files pass these variables through, plus optional `UMANS_API_KEY` for Exa-only search. Production does **not** read the development `.env`; configure its key separately when deploying. Preserve all production/dev data-volume boundaries and the single-Discord-instance-per-token rule in [AGENTS.md](../AGENTS.md). No production or Discord login is needed for offline checks.

```bash
./bin/test
./bin/check
./bin/build
./bin/validate-compose
./bin/secret-check
```

Optional `./bin/ai-search-smoke` exercises the real Logfare → Exa/Umans → Logfare tool loop using a temporary in-memory database, with no Discord connection or runtime history access. It reports only result metadata and requires both keys.

The AI tests use mocked transport and temporary/in-memory SQLite. They cover streaming boundaries, hidden reasoning, premature completion, provider limits, isolation/restart, provenance, model selection/metrics, typing lifecycle, image validation, history controls and compaction. They never call Discord or inference APIs.

Optional provider integration smoke (makes real Logfare requests using the configured key, but **never logs in to Discord**):

```bash
./bin/ai-smoke
```

This sends a short neutral chat and generates one small image request, reporting only result metadata. It does not read/write runtime history or connect to Discord; it is separate from normal CI tests. Discord UI acceptance still needs a separate development bot token or an explicitly authorized production stop.
