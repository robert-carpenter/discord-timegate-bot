const {
  Client,
  Events,
  GatewayIntentBits,
  PermissionsBitField,
  PermissionFlagsBits,
  REST,
  Routes,
  ApplicationCommandOptionType,
} = require('discord.js');
const { loadConfig, saveDailyLimit, saveGuildConfig } = require('./config');
const { StateStore } = require('./stateStore');

const BLOCK_DURATION_MS = 24 * 60 * 60 * 1000;
const config = loadConfig();
const state = new StateStore(config.dataFile);

const guildConfigs = new Map(
  config.guilds.map((g) => [
    g.id,
    {
      ...g,
      limitMs: g.dailyLimitMinutes * 60 * 1000,
    },
  ])
);

const setupSessions = new Map(); // guildId -> { userId, step, data }

const slashCommands = [
  {
    name: 'setup',
    description: 'Configure block role, track role, and daily limit for this server',
    dm_permission: false,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'block_role',
        description: 'Role that blocks voice connect',
        type: ApplicationCommandOptionType.Role,
        required: true,
      },
      {
        name: 'track_role',
        description: 'Role required to be timed',
        type: ApplicationCommandOptionType.Role,
        required: true,
      },
      {
        name: 'daily_limit_minutes',
        description: 'Daily limit in minutes',
        type: ApplicationCommandOptionType.Integer,
        required: true,
        min_value: 1,
      },
    ],
  },
  {
    name: 'time',
    description: 'Show remaining voice time',
    dm_permission: false,
    options: [
      {
        name: 'user',
        description: 'User to check (Manage Server required for others)',
        type: ApplicationCommandOptionType.User,
        required: false,
      },
    ],
  },
  {
    name: 'setlimit',
    description: 'Update the daily voice limit (Manage Server only)',
    dm_permission: false,
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        name: 'minutes',
        description: 'Daily limit in minutes',
        type: ApplicationCommandOptionType.Integer,
        required: true,
        min_value: 1,
      },
    ],
  },
];

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
  for (const [, g] of guildConfigs) {
    console.log(
      `Guild: ${g.id} | Block role: ${g.blockRoleId} | Track role: ${g.trackRoleId} | Daily limit: ${g.dailyLimitMinutes} minutes`
    );
  }

  // Clear stale sessions that may linger from a previous run.
  state.clearActiveSessions();

  setInterval(processExpiredBlocks, 60 * 1000);
  setInterval(checkActiveSessions, 30 * 1000);

  registerSlashCommands().catch((err) => {
    console.error('Failed to register slash commands:', err);
  });
});

client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);
client.on(Events.MessageCreate, handleMessageCreate);
client.on(Events.InteractionCreate, handleInteractionCreate);

client.login(config.token);

async function handleVoiceStateUpdate(oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  const guildConfig = guildConfigs.get(member.guild.id);
  if (!guildConfig) return;
  if (!shouldTrack(member, guildConfig)) return;

  const now = Date.now();
  const joinedChannel = !oldState.channelId && Boolean(newState.channelId);
  const leftChannel = Boolean(oldState.channelId) && !newState.channelId;
  const switchedChannel =
    Boolean(oldState.channelId) &&
    Boolean(newState.channelId) &&
    oldState.channelId !== newState.channelId;

  if (state.isBlocked(member.guild.id, member.id, now)) {
    if (joinedChannel || switchedChannel) {
      await disconnectMember(newState);
    }
    return;
  }

  if (joinedChannel) {
    state.startSession(member.guild.id, member.id, now);
    return;
  }

  if (leftChannel) {
    state.endSession(member.guild.id, member.id, now);
    await maybeBlock(member, guildConfig, now);
    return;
  }

  if (switchedChannel) {
    state.endSession(member.guild.id, member.id, now);
    const blocked = await maybeBlock(member, guildConfig, now);
    if (!blocked) {
      state.startSession(member.guild.id, member.id, now);
    }
  }
}

async function maybeBlock(member, guildConfig, nowMs) {
  const remaining = state.getRemainingMs(member.guild.id, member.id, nowMs, guildConfig.limitMs);
  if (remaining > 0) return false;
  await blockMember(member, guildConfig, nowMs);
  return true;
}

async function blockMember(member, guildConfig, nowMs) {
  const expiresAt = nowMs + BLOCK_DURATION_MS;
  state.setBlock(member.guild.id, member.id, expiresAt);

  try {
    await member.roles.add(guildConfig.blockRoleId, 'Daily voice limit reached');
  } catch (err) {
    console.error(`Failed to assign block role to ${member.id}:`, err);
  }

  await disconnectMember(member.voice);

  try {
    await member.send(
      `You have hit the ${guildConfig.dailyLimitMinutes} minute voice limit. You have been blocked from voice for 24 hours.`
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
  for (const [guildId, guildConfig] of guildConfigs.entries()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    const blockedIds = state.getBlockedUserIds(guildId, now);
    for (const userId of blockedIds) {
      const member = await fetchMember(guild, userId);
      if (member && member.roles.cache.has(guildConfig.blockRoleId)) {
        try {
          await member.roles.remove(guildConfig.blockRoleId, 'Timegate expired');
        } catch (err) {
          console.error(`Failed to remove block role from ${userId}:`, err);
        }
      }
      state.clearBlock(guildId, userId);
      try {
        if (member) {
          await member.send('Your 24-hour voice block has expired. You can join voice again.');
        }
      } catch {
        // ignore DM failures
      }
    }
  }
}

async function checkActiveSessions() {
  const now = Date.now();
  for (const [guildId, guildConfig] of guildConfigs.entries()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const activeIds = state.getActiveSessionIds(guildId);
    for (const userId of activeIds) {
      const remaining = state.getRemainingMs(guildId, userId, now, guildConfig.limitMs);
      if (remaining > 0) continue;
      const member = await fetchMember(guild, userId);
      if (!member) continue;
      state.endSession(guildId, userId, now);
      await blockMember(member, guildConfig, now);
    }
  }
}

async function handleMessageCreate(message) {
  if (message.author.bot) return;
  const guildId = message.guild?.id;
  const activeSetup = guildId ? setupSessions.get(guildId) : null;

  // Handle setup flow messages (no prefix needed) first.
  if (activeSetup && activeSetup.userId === message.author.id) {
    await handleSetupResponse(message, activeSetup);
    return;
  }

  if (!message.content.startsWith(config.commandPrefix)) return;

  const guildConfig = guildId ? guildConfigs.get(guildId) : null;

  const args = message.content.slice(config.commandPrefix.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  switch (command) {
    case 'setup':
      await handleSetupCommand(message);
      break;
    case 'time':
    case 'status':
      if (!guildConfig) {
        await promptSetupNeeded(message);
        return;
      }
      await handleStatusCommand(message, guildConfig, args);
      break;
    case 'setlimit':
      if (!guildConfig) {
        await promptSetupNeeded(message);
        return;
      }
      await handleSetLimitCommand(message, args, guildConfig);
      break;
    case 'help':
      await message.reply(
        `Commands: ${config.commandPrefix}setup (Manage Guild) | ${config.commandPrefix}time | ${config.commandPrefix}setlimit <minutes> (Manage Guild only)`
      );
      break;
    default:
      await message.reply('Unknown command. Try the help command.');
  }
}

async function handleStatusCommand(message, guildConfig, args) {
  const now = Date.now();
  const target = await resolveTargetMember(message, args, guildConfig);
  if (!target) return;

  if (!shouldTrack(target, guildConfig)) {
    await message.reply(
      target.id === message.author.id
        ? 'You are not in the tracked role; no voice limit is applied.'
        : `${target.user.tag} is not in the tracked role; no voice limit is applied.`
    );
    return;
  }

  const remainingMs = state.getRemainingMs(message.guild.id, target.id, now, guildConfig.limitMs);
  const isBlocked = state.isBlocked(message.guild.id, target.id, now);
  const blockExpiresAt = state.getBlockExpiry(message.guild.id, target.id);

  if (isBlocked) {
    const expiry = blockExpiresAt ? new Date(blockExpiresAt).toUTCString() : 'unknown time';
    await message.reply(
      target.id === message.author.id
        ? `You are blocked from voice until ${expiry}.`
        : `${target.user.tag} is blocked from voice until ${expiry}.`
    );
    return;
  }

  await message.reply(
    target.id === message.author.id
      ? `You have ${formatDuration(remainingMs)} of voice time left today.`
      : `${target.user.tag} has ${formatDuration(remainingMs)} of voice time left today.`
  );
}

async function handleSetLimitCommand(message, args, guildConfig) {
  if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await message.reply('You need the Manage Server permission to change the limit.');
    return;
  }

  const minutes = Number(args[0]);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    await message.reply('Usage: setlimit <minutes> (positive number)');
    return;
  }

  guildConfig.dailyLimitMinutes = minutes;
  guildConfig.limitMs = minutes * 60 * 1000;
  saveDailyLimit(message.guild.id, minutes);
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

function shouldTrack(member, guildConfig) {
  return member?.roles.cache.has(guildConfig.trackRoleId);
}

async function resolveTargetMember(message, args, guildConfig) {
  if (!args || args.length === 0) return message.member;
  if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await message.reply('You need the Manage Server permission to view other users.');
    return null;
  }

  const raw = args[0];
  const id = parseUserId(raw);
  if (!id) {
    await message.reply('Please mention a user or provide a valid user ID.');
    return null;
  }

  const member =
    message.guild.members.cache.get(id) ||
    (await message.guild.members.fetch(id).catch(() => null));

  if (!member) {
    await message.reply('Could not find that user in this server.');
    return null;
  }

  return member;
}

function parseUserId(input) {
  const mention = input.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  const idMatch = input.match(/^\d+$/);
  return idMatch ? idMatch[0] : null;
}

async function handleSetupCommand(message) {
  if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await message.reply('You need the Manage Server permission to run setup.');
    return;
  }

  if (setupSessions.has(message.guild.id)) {
    await message.reply('Setup is already in progress for this server. Finish the current setup or wait for it to time out.');
    return;
  }

  setupSessions.set(message.guild.id, {
    userId: message.author.id,
    step: 'blockRoleId',
    data: {},
  });

  await message.reply(
    'Timegate setup started. Step 1/3: Reply with the **role ID or mention** for the blocking role (the role that prevents voice connect).'
  );
}

async function handleSetupResponse(message, session) {
  const guildId = message.guild.id;
  const content = message.content.trim();

  if (session.step === 'blockRoleId') {
    const roleId = parseRoleId(content);
    const role = roleId ? message.guild.roles.cache.get(roleId) : null;
    if (!role) {
      await message.reply('Could not find that role. Please reply with a valid role ID or mention for the blocking role.');
      return;
    }
    session.data.blockRoleId = role.id;
    session.step = 'trackRoleId';
    await message.reply(
      'Step 2/3: Reply with the **role ID or mention** for the tracking role (members with this role are timed).'
    );
    return;
  }

  if (session.step === 'trackRoleId') {
    const roleId = parseRoleId(content);
    const role = roleId ? message.guild.roles.cache.get(roleId) : null;
    if (!role) {
      await message.reply('Could not find that role. Please reply with a valid role ID or mention for the tracking role.');
      return;
    }
    session.data.trackRoleId = role.id;
    session.step = 'dailyLimitMinutes';
    await message.reply('Step 3/3: Reply with the **daily limit in minutes** (positive number).');
    return;
  }

  if (session.step === 'dailyLimitMinutes') {
    const minutes = Number(content);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      await message.reply('Please enter a positive number of minutes.');
      return;
    }
    session.data.dailyLimitMinutes = minutes;
    await finalizeSetup(message, session);
    setupSessions.delete(guildId);
  }
}

async function finalizeSetup(message, session) {
  const guildId = message.guild.id;
  const merged = applySetup(guildId, {
    blockRoleId: session.data.blockRoleId,
    trackRoleId: session.data.trackRoleId,
    dailyLimitMinutes: session.data.dailyLimitMinutes,
  });

  await message.reply(
    `Setup complete. Blocking role: <@&${merged.blockRoleId}>, Tracking role: <@&${merged.trackRoleId}>, Daily limit: ${merged.dailyLimitMinutes} minutes.`
  );
}

function parseRoleId(input) {
  const mentionMatch = input.match(/^<@&(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];
  const idMatch = input.match(/^\d+$/);
  return idMatch ? idMatch[0] : null;
}

async function promptSetupNeeded(message) {
  await message.reply(
    `This server is not configured yet. An admin can run \`${config.commandPrefix}setup\` to configure block role, track role, and daily limit.`
  );
}

function applySetup(guildId, data) {
  const merged = {
    id: guildId,
    blockRoleId: data.blockRoleId,
    trackRoleId: data.trackRoleId,
    dailyLimitMinutes: data.dailyLimitMinutes,
    limitMs: data.dailyLimitMinutes * 60 * 1000,
  };

  guildConfigs.set(guildId, merged);
  saveGuildConfig({
    id: guildId,
    blockRoleId: merged.blockRoleId,
    trackRoleId: merged.trackRoleId,
    dailyLimitMinutes: merged.dailyLimitMinutes,
  });

  return merged;
}

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
  console.log('Slash commands registered globally.');
}

async function handleInteractionCreate(interaction) {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'This bot only works in servers.', ephemeral: true });
    return;
  }
  const guildConfig = guildConfigs.get(guildId);

  switch (interaction.commandName) {
    case 'setup':
      await handleSetupInteraction(interaction);
      break;
    case 'time':
      if (!guildConfig) {
        await promptSetupNeededInteraction(interaction);
        return;
      }
      await handleStatusInteraction(interaction, guildConfig);
      break;
    case 'setlimit':
      if (!guildConfig) {
        await promptSetupNeededInteraction(interaction);
        return;
      }
      await handleSetLimitInteraction(interaction, guildConfig);
      break;
    default:
      break;
  }
}

async function handleStatusInteraction(interaction, guildConfig) {
  const now = Date.now();
  const targetUser = interaction.options.getUser('user') || interaction.user;

  if (targetUser.id !== interaction.user.id) {
    const member = interaction.member;
    if (!member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to view other users.',
        ephemeral: true,
      });
      return;
    }
  }

  const member =
    interaction.guild.members.cache.get(targetUser.id) ||
    (await interaction.guild.members.fetch(targetUser.id).catch(() => null));

  if (!member) {
    await interaction.reply({ content: 'Could not find that user in this server.', ephemeral: true });
    return;
  }

  if (!shouldTrack(member, guildConfig)) {
    await interaction.reply({
      content:
        member.id === interaction.user.id
          ? 'You are not in the tracked role; no voice limit is applied.'
          : `${member.user.tag} is not in the tracked role; no voice limit is applied.`,
      ephemeral: true,
    });
    return;
  }

  const remainingMs = state.getRemainingMs(interaction.guildId, member.id, now, guildConfig.limitMs);
  const isBlocked = state.isBlocked(interaction.guildId, member.id, now);
  const blockExpiresAt = state.getBlockExpiry(interaction.guildId, member.id);

  if (isBlocked) {
    const expiry = blockExpiresAt ? new Date(blockExpiresAt).toUTCString() : 'unknown time';
    await interaction.reply({
      content:
        member.id === interaction.user.id
          ? `You are blocked from voice until ${expiry}.`
          : `${member.user.tag} is blocked from voice until ${expiry}.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content:
      member.id === interaction.user.id
        ? `You have ${formatDuration(remainingMs)} of voice time left today.`
        : `${member.user.tag} has ${formatDuration(remainingMs)} of voice time left today.`,
    ephemeral: true,
  });
}

async function handleSetLimitInteraction(interaction, guildConfig) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await interaction.reply({ content: 'You need the Manage Server permission to change the limit.', ephemeral: true });
    return;
  }
  const minutes = interaction.options.getInteger('minutes');
  if (!Number.isFinite(minutes) || minutes <= 0) {
    await interaction.reply({ content: 'Minutes must be a positive number.', ephemeral: true });
    return;
  }

  guildConfig.dailyLimitMinutes = minutes;
  guildConfig.limitMs = minutes * 60 * 1000;
  saveDailyLimit(interaction.guildId, minutes);
  await interaction.reply({ content: `Daily voice limit updated to ${minutes} minutes.`, ephemeral: true });
}

async function handleSetupInteraction(interaction) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
    await interaction.reply({ content: 'You need the Manage Server permission to run setup.', ephemeral: true });
    return;
  }

  const blockRole = interaction.options.getRole('block_role');
  const trackRole = interaction.options.getRole('track_role');
  const minutes = interaction.options.getInteger('daily_limit_minutes');

  const merged = applySetup(interaction.guildId, {
    blockRoleId: blockRole.id,
    trackRoleId: trackRole.id,
    dailyLimitMinutes: minutes,
  });

  await interaction.reply({
    content: `Setup complete. Blocking role: <@&${merged.blockRoleId}>, Tracking role: <@&${merged.trackRoleId}>, Daily limit: ${merged.dailyLimitMinutes} minutes.`,
    ephemeral: true,
  });
}

async function promptSetupNeededInteraction(interaction) {
  await interaction.reply({
    content: `This server is not configured yet. An admin can run \`${config.commandPrefix}setup\` (text) or \`/setup\` to configure block role, track role, and daily limit.`,
    ephemeral: true,
  });
}
