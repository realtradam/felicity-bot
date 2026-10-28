# Operations

## Entry points

Use the executable scripts in `bin/`; do not invoke Compose directly. They select the project name/file and explicitly load the project-root `.env` when present, otherwise using an empty env file. Compose parses the file; it is never sourced as shell code. Scripts use Bash strict mode. Those accessing gopass set `GPG_TTY` when a terminal is available.

| Script                 | Purpose                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `bin/setup`            | Build development image, install locked dependencies in named volume        |
| `bin/up`               | Load local `.env` (or gopass fallback); start with live reload              |
| `bin/down`             | Stop services; retain volumes                                               |
| `bin/logs`             | Follow logs                                                                 |
| `bin/check`            | Typecheck, lint, verify formatting                                          |
| `bin/test`             | Vitest; passes additional arguments to the test runner                      |
| `bin/build`            | Compile JS to bind-mounted `dist/`                                          |
| `bin/image-build`      | Build production image tagged `felicity-bot:local`                          |
| `bin/shell`            | Open a shell in the development container                                   |
| `bin/format`           | Apply Prettier                                                              |
| `bin/audit`            | Audit installed dependencies                                                |
| `bin/validate-compose` | Validate both Compose files without credentials                             |
| `bin/data-backup PATH` | Back up stopped development data volume to a new archive                    |
| `bin/smoke`            | Test production image offline: non-root, SQLite, writable storage, commands |
| `bin/ci`               | Install, check, test, compile, build production image                       |
| `bin/dev_secrets`      | Prompt/store missing development token                                      |
| `bin/prod_secrets`     | Prompt/store separate production token, emit deployment env to stdout       |

The first `bin/setup` may download Node and native build tools into the Docker image. Nothing is installed system-wide on the host. Development and production run as the image's `node` user (UID 1000); bind-mounted source must be readable/writable accordingly.

## Configuration

| Variable             | Required?      | Meaning                                                      |
| -------------------- | -------------- | ------------------------------------------------------------ |
| `DISCORD_TOKEN`      | Runtime/deploy | Bot token from local `.env`, environment, or gopass fallback |
| `DISCORD_CLIENT_ID`  | Runtime/deploy | Discord application ID                                       |
| `DATA_DIR`           | No             | Defaults to `./data`; Compose uses `/app/data`               |
| `PREVIEW_CACHE_SIZE` | No             | App-preview LRU limit, default 100, allowed 10–2,000         |
| `LOG_LEVEL`          | No             | `info` by default; Pino levels including `silent` supported  |

Optional notification configuration: `AI_GATEWAY_API_KEY` (or legacy `VERCEL_TOKEN`) supplies the existing free-tier AI Gateway key; `OPENAI_RESET_ENABLED=false` disables monitoring. Never print/commit keys or enable auto-recharge for this feature. See [OpenAI notifications](openai-notifications.md) for the $0.05 lifetime local credit cap, fixed model, source limits, subscription commands and confidence semantics.

Dev secret: `projects/discordbot-felicity/dev/discord_token`.
Production secret: `projects/discordbot-felicity/prod/discord_token`.
Local development uses a git-ignored `.env` with owner-only permissions (`chmod 600 .env`). `.env.example` contains non-secret settings only. Exported environment variables override `.env`. If `.env` is missing, startup falls back to gopass; an incomplete `.env` does not silently mix in gopass credentials. Never commit `.env` or reuse production credentials in development.

## AI chat and images

`LOGFARE_API_KEY` enables channel-scoped AI chat and image commands; `AI_CHAT_ENABLED=false` disables both. The optional feature defaults to GLM 5.3 chat and FLUX.1 Schnell images. The sole optional AI tool is Exa search via Umans (`UMANS_API_KEY`), matching Dispatch; there is no Firecrawl or other tool access. Both Compose configurations pass both keys through; production needs its own Dokploy environment entry. No deploy/start/stop is implied by changing source configuration.

See [AI chat](ai-chat.md) for commands, first-token typing, per-channel history/100k compaction, TTFT/TPS metrics, bedtime errors, provider logging and limitations. The separate `ai.sqlite` contains directed message text, sender metadata, summary, settings and output reply IDs, so whole-directory backups now contain private conversation content. `!ai clear` does not erase provider logs, Discord messages or backups. Ordinary channel messages are still not collected as transcripts.

`bin/ai-smoke` makes a real provider chat/image request without connecting to Discord or touching stored history; normal `bin/test`, `bin/check` and `bin/build` remain offline. Never run two Discord-connected bot instances on the same token for a UI test.

## Persistence and backup

Development Compose project: `felicity-dev`.

- `felicity-dev_node_modules`: installed dependencies.
- `felicity-dev_npm_cache`: npm download cache.
- `felicity-dev_bot_data`: SQLite, emoji images, metadata and readiness heartbeat.

Notifications use a separate `notifications.sqlite` schema-1 database in this same data directory, holding channel registrations, post/delivery journal and credit accounting. The stopped whole-directory backup below includes it and its WAL sidecars; do not reset it to bypass a budget. Existing emoji/history schema 5 is unchanged by notifications.

Stopping does not remove these volumes. Never remove the data volume unless you deliberately intend to destroy the archive and statistics. A fresh database is automatically migrated on startup; no separate DB service or migration command is necessary for schema version 5 (version-1/2/3/4 databases migrate automatically, preserving assets, upload IDs, counts and scan progress).

Take a consistent backup while the bot is stopped:

```bash
./bin/down
./bin/data-backup ./felicity-backup.tar.gz
./bin/up
```

The archive includes the entire data directory, including any SQLite WAL sidecars. Back up the database **and** image/metadata files together. Protect archives as server data; do not commit them. To restore, stop the bot, inspect the archive, and extract its contents into the empty mounted data directory using `bin/shell`, keeping ownership UID 1000. Do not merge unrelated database versions. Verify with a library listing and a non-destructive test upload before resuming operations.

## Production

`Dockerfile` is a multi-stage build: compile and install native modules in a builder, prune development packages, copy JS + runtime packages into a non-root Node 24 image. `docker-compose.prod.yml` is separate, with no source mounts, an isolated data volume, init, restart policy, dropped capabilities and a readiness healthcheck. No public ports are published.

Configure your container deployment platform with this production Compose file or the production Dockerfile, plus the three required variables. The platform must persist `/app/data` and allow outgoing HTTPS/WebSocket connections. Supply production secrets through the platform's environment settings; `bin/prod_secrets` prints `DISCORD_TOKEN=…` for this purpose **to stdout**, so do not run it in a logged CI job or redirect it into the repository. Set the non-secret application and server IDs separately.

Health checks read a timestamp written every 30 seconds only while the Discord client is ready. A stale/missing heartbeat makes the container unhealthy; Docker's restart policy alone does not restart a merely unhealthy process. Configure monitoring/redeployment in the platform. A fatal error or failed login exits nonzero. SIGTERM/SIGINT cancel scans, disconnect the client, wait for active tasks, and close SQLite; Docker gives a 30-second grace period with a 25-second process deadline.

Run one instance against each SQLite volume. Do not horizontally scale this scaffold over a shared SQLite file. Production data volume names depend on the deployment platform's Compose project name; back up the actual mounted volume, not the development one.

## Safety boundaries and follow-up work

- Message commands and data are guild-scoped: the bot answers in every server it has joined, and each server's emoji library, usage totals and scan ranges are stored under its own guild ID.
- No user token/self-bot support; no automatic server-wide history collection.
- There are no application-level caller-permission or role checks: any member in any server the bot has joined can invoke all commands, including emoji mutations. The bot still requires its own Discord permissions. Successful backup before deletion and operation locks remain in place.
- New uploads have no role restrictions. Backups preserve original restrictions, and swap rollback restores them.
- An API mutation and its local DB write cannot be one atomic transaction. A timeout or disk failure may leave Discord and local installation metadata out of sync. Inspect Discord and back up the current guild to reconcile before retrying.
- Live refreshes and history scans are idempotent, but overlapping snapshots/deletions may race. Missed events, inaccessible messages, and offline edits require reconciliation scans (`!history scan restart`). No exact-once claim is made.
- Scanned coverage ranges, unfinished gaps and archives persist (SQLite schema 5), but jobs themselves are not durable/automatically resumed. Regular/all scans always check newest messages first, skip covered ranges, and continue any unfinished older history. `restart` ignores prior coverage and replaces it after the first successfully stored page; counts remain idempotent. Legacy cursors migrate as a single known boundary, conservatively rechecking newer messages once. Run the command again after a process restart.
- Rate limits may outlast interaction deadlines. Existing backup files and completed scan pages are retained; partial success must be reviewed.
- Failures are logged without raw request bodies, headers, tokens or message content. Error types are logged rather than raw Discord error objects; investigate permissions/configuration/network first.

## Prefix commands, 7TV, and swap recovery

Bare `!emoji` opens the archive list and bare `!history` opens server-wide stats; `!help` is the grouped command menu. `stats_current` lists current server emoji slots only, least used first; `server_emoji` lists the same slots most used first and is not paged, splitting across messages when needed. All reports include the relative last-used time (such as 5 minutes ago) from the newest message containing the emoji in text or reactions; reaction dates deliberately use the message sent date, not the real reaction time. Zero-use rows say never observed.

The interface is `!emoji backup/list/swap/remove/add/steal` and `!history scan/stats/stats_channel/stats_current/server_emoji`; see the README for syntax. Message commands need no registration. Replies are public; the bot needs Send Messages in Threads for replies inside threads. Command execution does not check caller permissions or roles. Discord channel access determines who can send messages there; there is no bot-specific management-channel restriction.

SQLite version 2 adds image BLOBs, per-guild name aliases, source-provider mappings and an operation journal. SQLite images are authoritative; local image files remain a cache/export and a fallback for version-1 backups. Legacy file-only images are imported into SQLite when read/backed up. Keep pre-migration snapshots if you need to run older code: version-1 code cannot open version-2 databases.

`emoji_operations` records operation ID, guild, kind, state, non-secret details and last update. `complete` means finished; `outgoing_restored` means a failed swap restored the original asset under a new ID. `review_required`, or other in-progress states after a process interruption, must be inspected before retrying. There is no automatic mutation replay. Use `bin/shell` and the installed better-sqlite3 API for inspection, and compare the journal details against Discord's current emoji. Never blindly delete an emoji that merely shares a name with an uncertain upload.

Swaps preserve all known installation mappings and reconcile current availability against Discord when listing/stats commands run and at startup. External edits during a command, ambiguous API timeouts and local write failures can still require operator reconciliation. Full-channel scans stop at a 30-minute safety deadline, retain their last completed page, and can be resumed by another `!history scan`.

7TV metadata comes from `7tv.io/v3/emotes/:id`, images only from the allowlisted `cdn.7tv.app` emote path. The Sharp dependency performs static/animated conversion inside Docker, with pixel/frame/byte/time limits. No 7TV token is required. `bin/import-smoke [URL]` (after `bin/build`) verifies the real 7TV download/conversion/archive roundtrip in temporary storage without Discord mutations.

## Direct-image imports and custom names

`!emoji add <link> [name]` accepts 7TV links and direct public HTTPS images. Direct imports use undici with a custom DNS lookup that rejects non-public addresses and pins the checked DNS result to the actual connection. IP literals and every redirect are validated too; credentials, custom ports, local/private hosts and non-HTTPS destinations are rejected. Downloads have an overall 30-second deadline, an 8 MiB limit and at most three redirects. Signed image URLs are hashed for source mappings and operation provenance instead of persisting the raw URL. As ordinary Discord messages, the original requests remain visible in their channel.

Sharp validates image bytes rather than trusting extensions or Content-Type headers; PNG/JPEG/GIF/WebP/AVIF can be converted. Animations retain frames and become GIFs; unsupported images/HTML/SVG are rejected. Resolution/byte/frame/pixel limits are the same as 7TV conversions. Image operations use the same per-server lock, checksum-backed archive and installation-ID mapping.

Explicit names must be one word with 2–32 ASCII letters/digits/underscores. Installed-name conflicts are case-insensitively rejected. An explicit different name can install the same archived image twice with shared usage identity; no name means reuse an already installed asset rather than duplicating it. Requested backup aliases are preserved even on failed upload. The immutable asset's original default name is kept separate from each installation's chosen name.

## Self-contained storage and inline preview cache

The only project is the `bot/` repository. Scripts use Compose project `felicity-dev`, retaining the original database/dependency volumes. There is no image-service directory, public image server, hosting configuration, image publication command, or extra Docker network. Production needs only the bot container, its data volume, and outgoing Discord/image-source access. See [single-service Dokploy deployment](deployment.md).

Original PNG/GIF bytes live permanently in SQLite (`emoji_images`). Preview creation reads those bytes directly; it does not request a hosted URL or depend on exported local image files. Files remain useful for recovery of legacy archives. Schema 4 removes the retired `hosted_images` metadata table only, retaining all image/identity/statistics data. Pre-change snapshots are in the parent workspace's private `.local-backups/`.

`PREVIEW_CACHE_SIZE` controls the maximum number of Felicity-managed application preview emoji (default 100; 10–2,000). Managed preview names are `f_` followed by a content-derived 30-character hash prefix for archived images, or `x_` followed by the Discord emoji ID for untracked external emoji. The client refreshes current application emoji periodically, reuses stable previews after restart, and evicts its least recently used unprotected preview when capacity is needed. Only this managed namespace is eligible for deletion; unrelated application emoji and all server emoji are untouched. In-memory recency order resets after restart and is seeded from Discord. Existing over-capacity managed previews are trimmed on subsequent preview access, protecting current-page names.

List construction pins all missing native emoji on a page until the Discord reply finishes. Concurrent library-preview work is serialized so another page cannot evict a preview before that reply is sent. A page uses at most ten preview slots. Failed deletion/upload resets metadata for reconciliation before retry; ambiguous mutations are not blindly duplicated. If previews cannot be created, the message shows the stored name with a preview-unavailable marker. No URL fallback exists.

Eviction removes Discord application emoji permanently, so older messages referencing evicted IDs may lose rendering. Original image blobs stay in SQLite and can create a new preview ID whenever needed. Server upload-ID mappings and usage identity do not depend on preview IDs. Keep backups of the full data directory; losing a preview cache is harmless, losing the archive database is not.
