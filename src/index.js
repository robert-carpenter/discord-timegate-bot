const {
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
} = require('discord.js');
const { loadConfig, saveDailyLimit } = require('./config');
const { StateStore } = require('./stateStore');

const BLOCK_DURATION_MS = 24 * 60 * 60 * 1000;
const config = loadConfig();
const state = new StateStore(config.dataFile);

let limitMs = config.dailyLimitMinutes * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, () => {
  console.log(`Timegate bot ready as ${client.user.tag}`);
  console.log(
    `Guild: ${config.guildId} | Block role: ${config.blockRoleId} | Daily limit: ${config.dailyLimitMinutes} minutes`
  );

  // Clear stale sessions that may linger from a previous run.
  state.clearActiveSessions();

  setInterval(processExpiredBlocks, 60 * 1000);
  setInterval(checkActiveSessions, 30 * 1000);
});

client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);
client.on(Events.MessageCreate, handleMessageCreate);

client.login(config.token);

async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  if (member.guild.id !== config.guildId) return;
  if (!shouldTrack(member)) return;

  const now = Date.now();
  const joinedChannel = !oldState.channelId && Boolean(newState.channelId);
  const leftChannel = Boolean(oldState.channelId) && !newState.channelId;
  const switchedChannel =
    Boolean(oldState.channelId) &&
    Boolean(newState.channelId) &&
    oldState.channelId !== newState.channelId;

  if (state.isBlocked(member.id, now)) {
    if (joinedChannel || switchedChannel) {
      await disconnectMember(newState);
    }
    return;
  }

  if (joinedChannel) {
    state.startSession(member.id, now);
    return;
  }

  if (leftChannel) {
    state.endSession(member.id, now);
    await maybeBlock(member, now);
    return;
  }

  if (switchedChannel) {
    state.endSession(member.id, now);
    const blocked = await maybeBlock(member, now);
    if (!blocked) {
      state.startSession(member.id, now);
    }
  }
}

async function maybeBlock(member, nowMs) {
  const remaining = state.getRemainingMs(member.id, nowMs, limitMs);
  if (remaining > 0) return false;
  await blockMember(member, nowMs);
  return true;
}

async function blockMember(member, nowMs) {
  const expiresAt = nowMs + BLOCK_DURATION_MS;
  state.setBlock(member.id, expiresAt);

  try {
    await member.roles.add(config.blockRoleId, 'Daily voice limit reached');
  } catch (err) {
    console.error(`Failed to assign block role to ${member.id}:`, err);
  }

  await disconnectMember(member.voice);

  try {
    await member.send(
      `You have hit the ${config.dailyLimitMinutes} minute voice limit. You have been blocked from voice for 24 hours.`
    );
  } catch {
    // ignore DM failures
  }
}

async function disconnectMember(voiceState) {
  if (!voiceState || !voiceState.channelId) return;
  try {
    await voiceState.disconnect('Time limit reached');
  } catch (err) {
    console.error(`Failed to disconnect member ${voiceState.id}:`, err);
  }
}

async function processExpiredBlocks() {
  const now = Date.now();
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;

  const blockedIds = state.getBlockedUserIds(now);
  for (const userId of blockedIds) {
    const member = await fetchMember(guild, userId);
    if (member && member.roles.cache.has(config.blockRoleId)) {
      try {
        await member.roles.remove(config.blockRoleId, 'Timegate expired');
      } catch (err) {
        console.error(`Failed to remove block role from ${userId}:`, err);
      }
    }
    state.clearBlock(userId);
    try {
      if (member) {
        await member.send('Your 24-hour voice block has expired. You can join voice again.');
      }
    } catch {
      // ignore DM failures
    }
  }
}

async function checkActiveSessions() {
  const now = Date.now();
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const activeIds = state.getActiveSessionIds();
  for (const userId of activeIds) {
    const remaining = state.getRemainingMs(userId, now, limitMs);
    if (remaining > 0) continue;
    const member = await fetchMember(guild, userId);
    if (!member) continue;
    state.endSession(userId, now);
    await blockMember(member, now);
  }
}

async function handleMessageCreate(message) {
  if (message.author.bot) return;
  if (message.guild?.id !== config.guildId) return;
  if (!message.content.startsWith(config.commandPrefix)) return;

  const args = message.content.slice(config.commandPrefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  switch (command) {
    case 'time':
    case 'status':
      await handleStatusCommand(message);
      break;
    case 'setlimit':
      await handleSetLimitCommand(message, args);
      break;
    case 'help':
      await message.reply(
        `Commands: ${config.commandPrefix}time | ${config.commandPrefix}setlimit <minutes> (Manage Guild only)`
      );
      break;
    default:
      await message.reply('Unknown command. Try the help command.');
  }
}

async function handleStatusCommand(message) {
  const now = Date.now();
  if (!shouldTrack(message.member)) {
    await message.reply('You are not in the tracked role; no voice limit is applied.');
    return;
  }
  const remainingMs = state.getRemainingMs(message.author.id, now, limitMs);
  const isBlocked = state.isBlocked(message.author.id, now);
  const blockExpiresAt = state.getBlockExpiry(message.author.id);

  if (isBlocked) {
    const expiry = blockExpiresAt ? new Date(blockExpiresAt).toUTCString() : 'unknown time';
    await message.reply(`You are blocked from voice until ${expiry}.`);
    return;
  }

  await message.reply(`You have ${formatDuration(remainingMs)} of voice time left today.`);
}

async function handleSetLimitCommand(message, args) {
  if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await message.reply('You need the Manage Server permission to change the limit.');
    return;
  }

  const minutes = Number(args[0]);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    await message.reply('Usage: setlimit <minutes> (positive number)');
    return;
  }

  config.dailyLimitMinutes = minutes;
  limitMs = minutes * 60 * 1000;
  saveDailyLimit(minutes);
  await message.reply(`Daily voice limit updated to ${minutes} minutes.`);
}

async function fetchMember(guild, userId) {
  return (
    guild.members.cache.get(userId) ||
    (await guild.members.fetch(userId).catch(() => null))
  );
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function shouldTrack(member) {
  return member?.roles.cache.has(config.trackRoleId);
}
