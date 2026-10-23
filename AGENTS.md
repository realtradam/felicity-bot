# Felicity operational safety

## Always check production before running development

Before running `./bin/up`, `npm run dev`, or any other command that logs the bot into Discord, **check whether Felicity is running in production on Dokploy**. Never assume that a stopped local container means the token is unused.

- Dokploy: `http://xenifse1.chimera-dinosaur.ts.net:3000`
- Project: `felicity`; Compose service: `felicity-bot`; app name: `felicity-bot-ojxcoc`.
- Production source: `main`, `./docker-compose.prod.yml` at this repository's root.
- The existing local `.env` and production use the same bot application/token, targeting Notifs (`1499281440880201818`). Never print the token or commit credentials.

If production is running with the same token, stop it in Dokploy and confirm the bot container is stopped **before** starting development. If production status cannot be checked, do not start dev with that token. A genuinely separate Discord application/token may be used for development instead.

Before starting/resuming production, run `./bin/down` and confirm the local `felicity-dev` bot has stopped. Run exactly one instance per token: two instances can both answer commands and perform conflicting emoji mutations. There are intentionally no caller permission gates; do not add them as a deployment workaround.

Production was initialized with fresh data. Its `bot_data` volume is separate from `felicity-dev_bot_data`; do not overwrite, remove, or assume synchronization between them. Preserve the non-root runtime user and 30-second shutdown grace period.

Documentation-only changes and offline tests/builds do not require starting a Discord-connected bot. Run `./bin/secret-check` before committing or pushing. Never commit credentials, runtime data, or backups.
