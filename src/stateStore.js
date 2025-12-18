const fs = require('fs');
const path = require('path');

function dayKeyFromMs(ms) {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { guilds: {} };
    ensureDir(this.filePath);
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) {
      this._save();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.state = raw ? JSON.parse(raw) : { guilds: {} };
    } catch (err) {
      console.error('Failed to read state file:', err);
      this.state = { guilds: {} };
    }
  }

  _save() {
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  _getGuild(guildId) {
    if (!this.state.guilds[guildId]) {
      this.state.guilds[guildId] = { users: {} };
    }
    return this.state.guilds[guildId];
  }

  _getUser(guildId, userId) {
    const guild = this._getGuild(guildId);
    if (!guild.users[userId]) {
      guild.users[userId] = {
        currentSessionStart: null,
        dailyTotals: {},
        blockExpiresAt: null,
      };
    }
    return guild.users[userId];
  }

  startSession(guildId, userId, startMs) {
    const user = this._getUser(guildId, userId);
    user.currentSessionStart = startMs;
    this._save();
  }

  endSession(guildId, userId, endMs) {
    const user = this._getUser(guildId, userId);
    if (!user.currentSessionStart) return 0;
    this._addDurationAcrossDays(user, user.currentSessionStart, endMs);
    user.currentSessionStart = null;
    this._pruneOldDailyTotals(user, endMs);
    this._save();
    return this.getTotalForDay(guildId, userId, dayKeyFromMs(endMs));
  }

  _addDurationAcrossDays(user, startMs, endMs) {
    let cursor = startMs;
    while (cursor < endMs) {
      const nextMidnight = new Date(cursor);
      nextMidnight.setUTCHours(24, 0, 0, 0);
      const chunkEnd = Math.min(endMs, nextMidnight.getTime());
      const key = dayKeyFromMs(cursor);
      user.dailyTotals[key] = (user.dailyTotals[key] || 0) + (chunkEnd - cursor);
      cursor = chunkEnd;
    }
  }

  _pruneOldDailyTotals(user, referenceMs) {
    const reference = new Date(referenceMs);
    reference.setUTCDate(reference.getUTCDate() - 1);
    const cutoffKey = dayKeyFromMs(reference.getTime());
    for (const key of Object.keys(user.dailyTotals)) {
      if (key < cutoffKey) {
        delete user.dailyTotals[key];
      }
    }
  }

  getTotalForDay(guildId, userId, dayKey) {
    const user = this._getUser(guildId, userId);
    return user.dailyTotals[dayKey] || 0;
  }

  getRemainingMs(guildId, userId, nowMs, limitMs) {
    const user = this._getUser(guildId, userId);
    if (user.blockExpiresAt && user.blockExpiresAt > nowMs) return 0;
    const todayKey = dayKeyFromMs(nowMs);
    const baseTotal = user.dailyTotals[todayKey] || 0;
    const currentSession = user.currentSessionStart ? nowMs - user.currentSessionStart : 0;
    const remaining = limitMs - baseTotal - currentSession;
    return remaining > 0 ? remaining : 0;
  }

  isBlocked(guildId, userId, nowMs) {
    const user = this._getUser(guildId, userId);
    return Boolean(user.blockExpiresAt && user.blockExpiresAt > nowMs);
  }

  setBlock(guildId, userId, expiresAtMs) {
    const user = this._getUser(guildId, userId);
    user.blockExpiresAt = expiresAtMs;
    user.currentSessionStart = null;
    this._save();
  }

  clearBlock(guildId, userId) {
    const user = this._getUser(guildId, userId);
    user.blockExpiresAt = null;
    user.dailyTotals = {};
    user.currentSessionStart = null;
    this._save();
  }

  endAllSessions(nowMs) {
    for (const [guildId, guild] of Object.entries(this.state.guilds)) {
      for (const userId of Object.keys(guild.users)) {
        const user = this._getUser(guildId, userId);
        if (user.currentSessionStart) {
          this.endSession(guildId, userId, nowMs);
        }
      }
    }
  }

  clearActiveSessions() {
    let dirty = false;
    for (const guild of Object.values(this.state.guilds)) {
      for (const user of Object.values(guild.users)) {
        if (user.currentSessionStart) {
          user.currentSessionStart = null;
          dirty = true;
        }
      }
    }
    if (dirty) this._save();
  }

  getActiveSessionIds(guildId) {
    const guild = this._getGuild(guildId);
    return Object.entries(guild.users)
      .filter(([, data]) => Boolean(data.currentSessionStart))
      .map(([id]) => id);
  }

  getBlockedUserIds(guildId, nowMs) {
    const guild = this._getGuild(guildId);
    return Object.entries(guild.users)
      .filter(([, data]) => data.blockExpiresAt && data.blockExpiresAt > nowMs)
      .map(([id]) => id);
  }

  getBlockExpiry(guildId, userId) {
    const user = this._getUser(guildId, userId);
    return user.blockExpiresAt;
  }
}

module.exports = {
  StateStore,
  dayKeyFromMs,
};
