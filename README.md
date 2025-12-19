# Discord Timegate Bot

Tracks how long users stay in voice channels, blocks them once they hit a configured daily limit, and automatically removes the block after 24 hours. Supports multiple guilds with per-guild roles and limits.

## Prerequisites
- Node.js 18+ (uses discord.js v14)
- A Discord bot token
- Enable **Message Content Intent** and **Server Members Intent** in the bot settings
- A role in your server that **disallows connecting to voice** (set `Connect` permission to `Off`). The bot will add/remove this role to enforce the limit.
- A role that marks members to be tracked for voice time (only members with this role are timed).

## Setup
1) Copy config examples and fill in your values:
   ```bash
   cp .env.example .env
   cp config.example.json config.json
   ```
   - `DISCORD_TOKEN` / `token`: Bot token
   - `COMMAND_PREFIX` / `commandPrefix`: Defaults to `!tg`
   - `guilds[]`: Optional preconfigured guild list. If omitted, configure each guild with the setup command.
     - `id`: Server ID
     - `blockRoleId`: Role that prevents joining voice
     - `trackRoleId`: Role required to be timed
     - `dailyLimitMinutes`: Allowed voice minutes per 24h window
   - (Optional) For a single guild you can set `GUILD_ID`, `BLOCK_ROLE_ID`, `TRACK_ROLE_ID`, and `DAILY_LIMIT_MINUTES` in `.env` instead of editing `config.json`.
   - `COMMAND_PREFIX` / `commandPrefix`: Defaults to `!tg`

2) Install dependencies:
   ```bash
   npm install
   ```

3) Run the bot:
   ```bash
   npm start
   ```

State is stored in `data/state.json` by default.

## Commands
Slash (preferred):
- `/setup block_role:<role> track_role:<role> daily_limit_minutes:<int>` – configure guild (Manage Server).
- `/time [user]` – show remaining time/block status. Checking others requires Manage Server.
- `/setlimit minutes:<int>` – update daily limit (Manage Server).

Text (legacy):
- `!tg setup` – interactive setup (Manage Server).
- `!tg time [user]` / `!tg status [user]` – self or others (others require Manage Server).
- `!tg setlimit <minutes>` – update limit (Manage Server).
- `!tg help` – quick help text.

## Deploying on Railway (Docker)
1) Ensure your repository has the `Dockerfile` (included here).
2) In Railway, create a new project from this repo.
3) Set environment variables in the service:
   - `DISCORD_TOKEN` (required)
   - `COMMAND_PREFIX` (optional)
   - Either:
     - Single guild via env: `GUILD_ID`, `BLOCK_ROLE_ID`, `TRACK_ROLE_ID`, `DAILY_LIMIT_MINUTES`
     - Or include a `config.json` in the repo with `guilds[]` configured (no secrets).
   - Optionally `DATA_FILE` (e.g., `/data/state.json`) if you mount a volume for persistence.
4) Build & deploy. The start command is `npm start` (from the Dockerfile).

Notes for Railway:
- File writes (state/config changes) are not persisted across deploys unless you attach a volume. If you need persistence, set `DATA_FILE` to a path on a mounted volume (e.g., `/data/state.json`) and attach a Railway volume to `/data`.
- The bot uses the configured env/config at startup; `!tg setlimit` writes to `config.json` in the container, which will be lost on redeploy if not backed by a volume. Prefer env/config baked in the repo or add a volume for persistence.

## How it works
- The bot listens for `voiceStateUpdate` events to start/end sessions (per guild).
- Time is accumulated per UTC day. When usage reaches the guild's daily limit, the bot:
  - Ends the session,
  - Assigns the guild's blocking role,
  - Disconnects the user,
  - Sets a 24-hour expiry for the block and DMs the user (if possible).
- Background tasks run every minute to remove expired blocks and every 30 seconds to catch users who hit the limit while still connected.
- When the 24-hour block expires, the blocking role is removed and the user's counters reset.

## Notes
- Supports multiple guilds; configure each under `guilds[]` in `config.json`.
- Make sure the bot role is above the blocking role so it can assign/remove it.
- Only members with the tracking role are timed or blocked; others are ignored.
- Configure the blocking role to explicitly disallow the **Connect** permission for voice channels you want to gate.
