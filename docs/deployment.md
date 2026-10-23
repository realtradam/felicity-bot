# Felicity on Dokploy — one service

Deploy the **bot repository** (`git@github.com:realtradam/felicity-bot.git`) as a single Docker Compose service on Dokploy. No image host, Nginx, domain, inbound port or cross-service Docker network is needed.

## Repository and build

1. Give Dokploy's GitHub App access to the bot repository.
2. Create a Compose deployment, choosing the repository and branch (`main` once committed/pushed).
3. Set Compose Path to `./docker-compose.prod.yml` (the repository root is this `bot/` folder, not the parent workspace).
4. Use a single-node Docker Compose deployment because SQLite lives on a local named volume.

The production Dockerfile builds TypeScript and native dependencies, prunes dev packages, and runs as a non-root user. The production Compose file uses init, health checks, a restart policy, a 30-second shutdown grace period, and a persistent `bot_data` volume mounted at `/app/data`. Source code is not bind-mounted.

## Automatic deployment

Dokploy auto-deploy is enabled for pushes to `main`. GitHub must have an active, push-only repository webhook pointing to `https://webhook.catgirls.rodeo/compose/<Dokploy deploy token>`, with content type `application/json`. The existing webhook forwarder relays it to the private Dokploy API; do not point GitHub directly at the LAN/Tailscale panel. Copy the actual deploy token from Dokploy; do not commit or log the token-bearing webhook URL. Without that repository webhook, enabling auto-deploy alone cannot deliver push events.

There is no GitHub Actions CI workflow. Checks/tests/builds remain available locally via `bin/`; run `./bin/secret-check` before committing or pushing. The webhook tells Dokploy to pull and rebuild the repository directly, without a GitHub Actions build job.

Stop the local `felicity-dev` bot before pushing to `main` or manually deploying production when they use the same token. Never start dev until production is confirmed stopped; see [operational safety](../AGENTS.md).

## Environment

Set these in Dokploy's Environment settings:

```dotenv
DISCORD_TOKEN=<production bot token>
DISCORD_CLIENT_ID=<Discord application ID>
DISCORD_GUILD_ID=<server ID>
PREVIEW_CACHE_SIZE=100
LOG_LEVEL=info
```

Use a separate Discord application/token for production when practical. Configure the bot's own Discord permissions and Message Content Intent as described in the README. Application preview emojis need no new server permission and do not use server slots. No application-level caller role/permission checks exist.

Do not set the retired `IMAGE_STORE_URL`, `IMAGE_STORE_TOKEN`, or `IMAGE_PUBLIC_URL` variables. They are no longer read. No external Docker bridge network needs creating. Do not add a public domain or host ports for the bot.

## Data and deployment

- Ensure the `bot_data` volume persists across redeployments. Back up the SQLite database plus legacy exports/metadata together while stopped.
- Original images are SQLite BLOBs. The 100-entry application-emoji cache is only for previews; its objects can be evicted/recreated without losing archived images.
- Schema 5 upgrades existing v1/v2/v3/v4 databases, preserves data and adds incremental scan coverage. Keep a snapshot before upgrading if rollback to older code is needed.
- Start the deployment and look for `Felicity is ready` in logs.
- Test `!help`, `!emoji list`, then non-destructive backups/scans before testing swaps/removals.
- Message commands need no registration. Slash commands are not supported.
- Use one bot instance per SQLite data volume. Do not run a second copy of the same bot concurrently for normal operation.

Dokploy's health status reads the bot's readiness heartbeat. Restart policies restart exited processes but do not automatically restart merely unhealthy ones; configure platform monitoring accordingly. Outgoing HTTPS/WebSocket access is required for Discord and imported image sources.

## Preview cache behavior

`PREVIEW_CACHE_SIZE` accepts 10–2,000; 100 is recommended. New library pages reuse previews and evict least-recently-used Felicity-managed application emoji as needed. Current-page previews are protected through send. Old messages may lose preview rendering after eviction because Discord assigns new IDs to re-uploads. Server emoji and archived usage identity are independent of those previews.

No separate web service is necessary for inline previews. If a future feature needs permanent public image URLs or a web gallery, it can be added as a sibling repository without moving this bot again.
