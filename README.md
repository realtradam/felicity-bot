# Felicity bot

This directory is the standalone **bot Git repository**. It stays in `bot/` so additional sibling services can be added in the future. The bot is self-contained: SQLite stores original image bytes and Discord application emoji provide inline previews. No image host, public HTTP server, domain, or shared Docker network is required. The original `felicity-dev` project and named data volumes are preserved.

A TypeScript/discord.js bot for archiving server emoji, managing uploads/removals, and measuring custom and Unicode emoji usage. Node 24, SQLite (`better-sqlite3`), Zod configuration, Pino logging, Vitest, ESLint, and Prettier.

Development runs in Docker. The host only needs Docker with Compose and Bash. Local credentials are loaded from a git-ignored `.env` file; gopass is optional. No inbound ports, public URL, or local TLS certificates are needed: the bot connects outbound to Discord.

## Quick start

### 1. Set up a Discord application

#### Saved Felicity invite link

[Invite Felicity to a server](https://discord.com/oauth2/authorize?client_id=690681378718613615&permissions=8934609227072&integration_type=0&scope=bot+applications.commands)

- Application ID: `690681378718613615`
- Felicity serves **every server it has been added to**; no server ID is configured. Development currently uses **Notifs**.
- The saved invite includes `bot` and `applications.commands`; only the `bot` scope is needed for message commands.
- Saved permission bitfield: `8934609227072` (includes Connect and Speak for possible future voice functionality; playback is not implemented).
- This is an invite URL, not a bot token. To let anyone outside the application team invite Felicity, enable **Public Bot** under Bot → Authorization Flow. Otherwise, open the link while signed into the application owner's account. Keep Installation → Install Link set to **None**.

#### Developer Portal setup

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and bot; copy the **application ID** and **bot token**. Use a dedicated development application, not your personal user token.
2. Enable **Message Content Intent** under Bot → Privileged Gateway Intents. No presence or member intent is needed.
3. In OAuth2 → URL Generator, select `bot`.
4. Grant the bot **View Channels**, **Read Message History**, **Send Messages**, **Attach Files**, **Create Expressions**, and **Manage Expressions**. Also grant **Send Messages in Threads** to reply to prefix commands inside threads. Voice-channel chat additionally requires **Connect**; normal text channels do not. Do not grant Administrator.
5. Invite it to your test server. Enable Discord Developer Mode, then copy the server ID.

The app requests guild, expression, message, message-content and reaction intents. Message Content access applies to historical HTTP responses too. Discord may require approval/review as the app grows.

### 2. Configure local credentials

This checkout is configured using a local **`.env`** file containing the bot token and application ID. The file is excluded from Git and Docker build contexts, with owner-only permissions (`600`). Never commit or share it.

For a fresh checkout, copy `.env.example` to `.env`, restrict its permissions, and fill in `DISCORD_TOKEN` locally:

```bash
cp .env.example .env
chmod 600 .env
```

The non-secret IDs are already provided in the example. Edit the token with your editor; do not paste it into chat or commit it.

Scripts pass `.env` to Docker Compose's dotenv parser rather than executing it as shell code. Exported environment variables override `.env` values. Existing containers must be recreated with `./bin/up` after changing the file.

If no `.env` exists, the previous gopass flow remains available via `./bin/dev_secrets`, with `DISCORD_CLIENT_ID` exported in your shell. The development gopass path is `projects/discordbot-felicity/dev/discord_token`.

### 3. Install dependencies and start

**Always check production before starting dev.** Felicity is deployed on [Dokploy](http://xenifse1.chimera-dinosaur.ts.net:3000), project `felicity` → service `felicity-bot`. The existing local `.env` uses the same bot token as production. Stop production and confirm its bot container has stopped before running `./bin/up`; if you cannot verify production status, do not start dev with that token. Alternatively, use a separate Discord application/token for development. Two instances can both answer commands and perform conflicting emoji mutations. Stop dev with `./bin/down` before resuming production. See [agent/operational safety](AGENTS.md).

```bash
./bin/setup
./bin/up
./bin/logs
```

No shell exports or gopass unlock are needed when `.env` is present. Tests and builds do not require live Discord access.

Message commands work immediately after startup; no command registration is needed. The bot serves **every server it has been added to**; no server ID is configured, and each server's emoji library, usage data, and scan history stay separated in the database.

## Message commands

Replies are ordinary, public messages in the invoking channel—not ephemeral. **All commands are available to any member in any server the bot has joined**, including emoji removal/swaps and history scans. There are no application-level role or caller-permission checks. Discord still enforces the bot’s own permissions. Bot/webhook messages are ignored and cannot trigger commands.

| Command                            | Behavior                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `!emoji backup`                    | Back up all current server emoji into SQLite: names, image blobs, and old/new Discord ID mappings; also save local files and metadata.  |
| `!emoji list [page]`               | Show ten compact inline emoji/name rows per page. Stored-only images use a bounded bot-owned preview cache loaded directly from SQLite. |
| `!emoji swap :old: backed-up-name` | Back up the outgoing emoji and install the archived incoming emoji. All IDs for the same archived emoji retain a shared usage identity. |
| `!emoji remove :emoji:`            | Back up first, then remove. No extra confirmation argument; the command itself requests deletion.                                       |
| `!emoji add <link> [name]`         | Import a 7TV emote or direct HTTPS image, optionally choose its name, back up automatically, and upload it.                             |
| `!emoji steal`                     | Reply to a message: add every custom emoji in it that this server does not already have, renaming on name conflicts.                    |
| `!history scan`                    | Catch up from newest messages to the previous scan, then continue any unfinished older history.                                         |
| `!history stats [page]`            | Server-wide observed text/reaction totals, combining old and new emoji IDs; show swapped-out/removed emoji.                             |
| `!history stats_current [page]`    | Current-server custom emoji only, including zero-use slots, least used first; useful for choosing swap candidates.                      |
| `!history stats_channel [page]`    | Same report, with usage restricted to the current channel/thread.                                                                       |
| `!history server_emoji`            | Every emoji currently installed on the server, most used first, with text/reaction totals and when each was last used; not paged.       |

`!emoji steal` must be sent as a reply. It reads custom emoji mentions from the replied-to message, skips emoji that are already installed on the server, and imports the rest through the normal archive/upload path, so stolen emoji are backed up like any other import. A name already used on the server gets a numeric suffix (`name_2`); names that are too short or contain invalid characters are replaced with a valid fallback. Unicode emoji, reactions and stickers are not stolen.

`!help` lists all message commands, grouped under small `###` prefix headers. Bare `!emoji` shows `!emoji list`; bare `!history` shows `!history stats`. Explicit `!emoji help` and `!history help` still show the full menu. Emoji selectors accept an actual Discord mention (`<:name:ID>`), `:name:`, bare name or numeric ID. Incoming swap targets accept backed-up names (case-insensitive) or a full asset ID (reported when a name is ambiguous). Duplicate/ambiguous names are rejected rather than guessing. Renamed emoji keep aliases. There is no `remote` command.

### Swaps and imports

- Incoming images are read and validated **before any removal**, and the outgoing image is backed up first.
- Swaps upload first when the target static/animated pool has space. At capacity, same-type swaps remove first; cross-type swaps require a free target slot. Capacity is estimated from boost tier/features; Discord remains authoritative.
- If the incoming upload fails after a removal, the bot checks current server state before attempting to restore the outgoing backup, including its role restrictions. Failed/ambiguous operations are journaled in SQLite and need operator review; they are not blindly retried.
- Uploads and restoration create new IDs. Every known ID remains mapped to the original archived identity, even if Discord re-encodes the uploaded file on its CDN.
- New uploads are unrestricted by role. Backup metadata keeps original roles; automatic rollback restores the outgoing roles.
- 7TV supports both current ULID links (like `01F010F9GR0007E4VV006YKSKN`) and older 24-character IDs. Links and CDN hosts are allowlisted; responses are size-limited. Images are padded/resized to at most 128×128 and encoded as PNG or GIF under 256 KiB. Large animations may be reduced in resolution or rejected; they are never silently flattened.
- Direct images: PNG, JPEG, GIF, WebP and AVIF are supported. Supply the actual image URL, not a web page; a filename extension is not required. Downloads are capped at 8 MiB, redirects at three, and only public HTTPS endpoints on the default port are accepted. DNS is validated at socket connection time to block private/local addresses and rebinding. HTML/SVG and unsupported or oversized animations are rejected.
- Optional names are one word, 2–32 ASCII letters, digits or underscores. Invalid explicit names are rejected, not silently changed. Without an explicit name, 7TV uses the emote name and direct images use a sanitized filename (falling back to `emoji`).
- Name conflicts with installed emoji are checked case-insensitively. They are **rejected**, never overwritten or automatically suffixed. Retry with another name. Archives may retain several assets under one name; swaps then report the matching asset IDs so you can choose one.
- Re-adding an already installed asset without an explicit name returns the existing emoji. Explicitly requesting a different, unused name creates another upload of the same asset, preserving shared usage identity. Providing the same name returns the existing emoji. Backups and requested aliases are retained even if upload fails or the name conflicts.
- Success replies render the emoji and say `was added as :name:`; IDs and backup boilerplate are omitted.

Examples:

```text
!emoji add https://7tv.app/emotes/60ae3e54259ac5a73e56a426 Thinking
!emoji add https://example.com/picture.png MyEmoji
!emoji add https://example.com/dance.gif
```

### History and statistics

`!history scan` and `!history scan all` start at the **newest messages** and stop at the previous scan's coverage. If older history was never finished, they skip the covered section and continue that older crawl. The first scan covers all accessible history. Requests use pages of up to 100 messages, with a 30-minute safety deadline and progress updates. Completed pages and gaps are saved durably, so interrupted/limited runs can continue without skipping messages.

```text
!history scan               # incremental catch-up + any unfinished older history
!history scan all           # same as above (all is the default)
!history scan 1000          # same behavior, at most 1000 unscanned messages (1–5000)
!history scan restart       # force a fresh full rescan, ignoring previous coverage
!history scan 1000 restart  # force a rescan, limited to 1000 messages this run
```

`restart` does not clear counts: it replaces snapshots for messages it revisits. It resets scan coverage only after the first successful page, so subsequent normal scans can finish that rescan. Re-running a normal scan does not refresh edits/reactions on already-covered old messages; use `restart` for offline changes or parser backfills. Live observations are not used as scan boundaries, because receiving a new message does not prove all earlier history was scanned. Old pre-incremental cursors lack a newest boundary, so the first scan after upgrading conservatively rechecks newer history once.

Run it inside **each channel/thread you want included**; there is no automatic discovery of archived/private threads or server-wide crawl. Server-wide stats aggregate channels already observed/scanned; they do not initiate a scan. A thread is a separate channel for `stats_channel`.

Stats include installed, archived-zero-use, and swapped-out emoji. Deleted/uninstalled IDs remain in the database, with outgoing identities labeled **swapped**. An emoji swapped back in returns to **installed**, with old/new counts combined. Unmapped external/deleted emoji IDs are reported as external/untracked because the bot cannot infer missing identities from names alone. Run `!emoji backup` before your first swaps to establish all current identities.

Stats render installed custom emoji inline and use the bot's cached application-emoji previews for archived/removed ones (text fallback if unavailable). Untracked custom emoji — usually ones from a server the bot is not in — are previewed by downloading their public Discord CDN image into the same bot-owned cache; nothing is added to the archive database. Standard Unicode emoji are included whenever observed in text or reactions, including flags, skin tones, keycaps and joined sequences. Presentation-selector variants share totals; different skin tones remain separate. The selector is restored when reporting, so text-default symbols such as ❤ and ☹ appear as emoji rather than monochrome text. Unicode entries do not get installation-state labels. Reports use ten entries per page: `!history stats 2` or `!history stats_channel 2`.

**Backfill after upgrading:** previous snapshots did not record Unicode emoji and message bodies are not stored. Run `!history scan restart` in each channel/thread to include older Unicode usage. New live messages/reactions are tracked automatically. A normal incremental scan deliberately skips already-covered messages.

`!history stats_current [page]` lists **each currently installed custom emoji slot in this server**, with server-wide counts sorted by fewest total uses first (older last-used day breaks ties). It excludes Unicode, removed backups and external emoji, but includes zero-use, managed and role-restricted installed emoji. Counts/dates still combine all known old/new IDs of the same archived image. Identical images installed under multiple names each show that shared total; the rows are not independent counts to add together. Zero means **never observed**, not proof of no historical usage—scan the relevant channels first.

`!history server_emoji` lists **every emoji currently installed on the server**, most used first, with the same text/reaction totals and relative last-used times. Emoji that were swapped out or removed are excluded. It is not paged: the full list is sent, continuing in additional messages when it exceeds Discord's 2,000-character message limit.

Every usage report includes an English relative time such as `last used 5 minutes ago` or `last used 1 month ago`, or `never observed` for zero-use entries. The time is based on the newest **message sent timestamp** where that emoji appears in text or reactions. Relative times are computed when the report is requested (not live-updating); months are approximately 30 days and years 365 days. Per the chosen convention, reactions use the message's sent date, **not** when someone actually reacted. Existing stored messages already have these dates; no date backfill rescan is needed. Dates are recalculated from surviving snapshots when messages/reactions are removed, and combined across old/new IDs like counts.

Management command arguments are excluded from text-popularity counts, so `!emoji remove :old:` does not count as organic usage. Repeated history scans replace per-message snapshots rather than duplicating counts. Text and reactions are shown separately; ordering uses their combined total. Counts reflect currently existing observed data, not a complete historical event ledger.

## Data and behavior

Persistent files inside the container:

```text
/app/data/
  felicity.sqlite       # image blobs, aliases, ID history, counts, operation journal, cursors
  emojis/<sha256>.png   # or .gif
  metadata/<guild>-<emoji>.json
  health.json          # readiness heartbeat for the production healthcheck
```

`data` is a **named Docker volume**, not the host's `./data` directory. See [operations](docs/operations.md) for persistence, backups and production deployment.

- No raw message text or author IDs are stored. Stored data includes message/channel/guild IDs, message timestamps, emoji IDs, derived counts, asset metadata and scan cursors.
- Text usage excludes bot/webhook-authored messages and management commands. Reactions to their messages are included. Reaction totals include bots and normal/super reactions; they are not distinct-human counts.
- Unicode emoji are excluded: they do not occupy custom server emoji slots.
- Cached/live message edits and reaction events trigger REST refreshes; deletion events remove stored usage. Missing events during downtime need explicit rescans. This is not an immutable event ledger or guaranteed-exact historical analytics system.
- History reports **currently existing** messages/reactions. Deleted history and previously removed reactions cannot be reconstructed. Reaction creation timestamps are not available in these snapshots.
- Names/roles/managed status are saved in backup metadata, but upload deliberately creates an emoji available to all roles. It does **not** automatically restore role restrictions; review them in Discord after uploading.
- Identical imported image bytes share one local asset identity. Known bot re-uploads keep their original identity even after CDN re-encoding. Unrelated manual re-uploads cannot always be linked automatically.
- Discord does not replace emoji images in place. Re-uploading always creates a **new ID**, even with the same name. Old references will not reconnect to the replacement.
- Discord enforces image size (256 KiB), format/dimensions, capacity and per-guild emoji rate limits. SDK rate-limit handling does not make delete/upload atomic. Check server capacity before removing anything.

## Development

```bash
./bin/check        # TypeScript + ESLint + formatting
./bin/test         # Unit tests; no Discord network access
./bin/format       # Apply formatting
./bin/build        # Compile production JS into dist/
./bin/image-build  # Build the non-root production image
./bin/smoke        # Validate built production image offline
./bin/import-smoke # Read-only 7TV import/archive test (run bin/build first)
./bin/audit        # npm dependency audit
./bin/ci           # Full install/check/test/build/image pipeline
./bin/shell        # Development container shell
./bin/down         # Stop, preserving all volumes
```

The source is bind-mounted; `tsx watch` reloads on changes. npm dependencies/cache live in named volumes, so the host does not need Node. TypeScript 6 is selected to stay within the installed typescript-eslint compatibility range; the lockfile pins the resolved dependency tree.

```text
src/
  config.ts            # Value-free environment validation errors
  index.ts             # Client lifecycle, events, shutdown
  discord/             # Message command handlers, shared context and ingestion
  emoji/               # Archive, swaps, public image/7TV imports, conversion, parsing
  history/             # Resumable, cancellable history backfill
  storage/             # SQLite schema and queries
```

## Scope / next steps

Implemented: prefix commands, database-backed emoji library, safe manual swaps/removals, 7TV/direct-image imports with optional names, persistent old/new ID mappings, full-channel backfills, server/channel rankings and basic rollback/journaling.

Not included yet: automatic least-used rotation, a durable background queue/automatic job resume, arbitrary attachment import, time-windowed rankings, automatic thread discovery, multi-server authorization, or a web dashboard. Discord API changes, timeouts and concurrent external admin edits can require manual reconciliation; no cross-service atomicity is claimed.

Before destructive production use, test backup → upload → swap/remove with disposable emoji. Unit tests use mocks and temporary databases. The read-only 7TV test does not upload anything to Discord.

## Inline previews: no image host

`!emoji list [page]` is a compact text list with real inline emoji—no cards, IDs, files or public image links. Usable server emoji are preferred. Otherwise the bot reads the archived PNG/GIF **directly from SQLite** and uploads it to its application-owned emoji slots. These previews are bot-only: they never occupy server slots or change server installations, archived identities, or usage counts.

Untracked emoji seen in statistics (for example one used in a message but never installed in this server) have no archived bytes. For those the bot downloads the emoji's public `cdn.discordapp.com/emojis/<id>` image and caches it the same way, under an `x_<emoji id>` preview name. Only previews are created; external emoji are not added to the archive or to any server.

The cache defaults to **100 previews**, configurable with `PREVIEW_CACHE_SIZE` (10–2,000). It reuses existing previews and evicts the least-recently-used Felicity-managed preview when full. Unrelated application emoji are never deleted. Current-page images are protected from eviction while its reply is being built/sent, and concurrent preview operations are serialized. Usage order is in memory, reseeded from Discord on restart; original image bytes are permanent in SQLite.

**Evicting a preview can break its rendering in older list messages.** A re-upload gets a new ID. Re-run the list for fresh previews. This does not affect ordinary server emoji or the archived images. Upload/delete requests still obey Discord rate limits; preview failures display the stored name with a short unavailable marker rather than failing the whole list. No separate hosting service or fallback URL is used.

SQLite schema 5 stores incremental scan coverage ranges; schema 4 removed the retired hosting publication table. Earlier databases migrate without removing image blobs, upload-ID history, aliases, usage or scan progress. Local image files remain exports/a fallback for old archives, but current archives can be restored even if those exported copies are absent.

The former `!emoji publish`, publishing scripts, image-host environment variables, and cross-service Docker network are removed. See [deployment](docs/deployment.md) for the single-service Dokploy setup.

## Before committing or pushing

Run `./bin/secret-check`. It scans all Git-eligible working files and all reachable local Git history with a digest-pinned Gitleaks container, with findings redacted. Run this check locally before committing or pushing; this repository has no GitHub Actions CI workflow. `.env`, runtime data, local caches/backups and private-key files are ignored/excluded from builds. `.env.example` contains placeholders/non-secret settings only. Discord application IDs are public, so only the scanner's `discord-client-id` rule is disabled; token/key/client-secret detectors remain enabled.

Never force-add ignored credentials. Review `git diff --cached` before committing. Secret scanners reduce risk but cannot guarantee detection of every credential format.
