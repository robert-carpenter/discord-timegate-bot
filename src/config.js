const fs = require('fs');
const path = require('path');
require('dotenv').config();

const CONFIG_PATH = path.resolve(process.cwd(), 'config.json');

function loadConfig() {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error('Failed to parse config.json:', err);
      process.exit(1);
    }
  }

  const config = {
    token: process.env.DISCORD_TOKEN || fileConfig.token,
    commandPrefix: process.env.COMMAND_PREFIX || fileConfig.commandPrefix || '!tg',
    dataFile: process.env.DATA_FILE || fileConfig.dataFile || path.resolve(process.cwd(), 'data', 'state.json'),
    guilds: Array.isArray(fileConfig.guilds) ? fileConfig.guilds : [],
  };

  // Allow single-guild env-based override without editing config.json
  if (process.env.GUILD_ID && process.env.BLOCK_ROLE_ID && process.env.TRACK_ROLE_ID) {
    config.guilds = [
      {
        id: process.env.GUILD_ID,
        blockRoleId: process.env.BLOCK_ROLE_ID,
        trackRoleId: process.env.TRACK_ROLE_ID,
        dailyLimitMinutes: Number(process.env.DAILY_LIMIT_MINUTES || 60),
      },
    ];
  }

  if (!config.token) {
    console.error('Missing bot token. Set DISCORD_TOKEN in .env or token in config.json');
    process.exit(1);
  }

  if (!Array.isArray(config.guilds)) {
    console.error('guilds must be an array in config.json');
    process.exit(1);
  }

  config.guilds.forEach((guild) => {
    if (!guild.id || !guild.blockRoleId || !guild.trackRoleId) {
      console.error(`Guild entry incomplete (id, blockRoleId, trackRoleId required). Offending entry: ${JSON.stringify(guild)}`);
      process.exit(1);
    }
    if (!Number.isFinite(guild.dailyLimitMinutes) || guild.dailyLimitMinutes <= 0) {
      console.error(`Guild ${guild.id} dailyLimitMinutes must be a positive number (minutes).`);
      process.exit(1);
    }
  });

  return config;
}

function saveDailyLimit(guildId, minutes) {
  return saveGuildConfig({ id: guildId, dailyLimitMinutes: minutes });
}

function saveGuildConfig(partialGuildConfig) {
  let existing = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      existing = {};
    }
  }

  // If guilds array exists, update the matching guild entry; otherwise seed one.
  let nextGuilds = Array.isArray(existing.guilds) ? existing.guilds : [];
  const idx = nextGuilds.findIndex((g) => g.id === partialGuildConfig.id);
  if (idx >= 0) {
    nextGuilds[idx] = { ...nextGuilds[idx], ...partialGuildConfig };
  } else {
    nextGuilds.push(partialGuildConfig);
  }

  const next = { ...existing, guilds: nextGuilds };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
}

module.exports = {
  loadConfig,
  saveDailyLimit,
  saveGuildConfig,
};
