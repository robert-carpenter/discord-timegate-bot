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

## Commands (text, no slash yet)
- `!tg setup` – interactive setup (requires **Manage Server**). Prompts for block role, track role, and daily limit. The bot ignores a guild until setup is complete.
- `!tg time [user]` or `!tg status [user]` – show remaining voice time or block expiry. Without a user it shows your own; with a user (mention/ID) it requires **Manage Server**.
- `!tg setlimit <minutes>` – update the daily limit (requires **Manage Server**). The value is also written to `config.json`.
- `!tg help` – quick help text.

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
