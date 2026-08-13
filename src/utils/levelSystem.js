import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EmbedBuilder } from 'discord.js';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '../../data/levels.json');

const SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MESSAGE_XP_MIN = 15;
const MESSAGE_XP_MAX = 25;
const MESSAGE_COOLDOWN_MS = 60 * 1000; // 60 seconds
const VOICE_XP_PER_MINUTE = 10;
const VOICE_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID || '1419789649873735680';

let data = { users: {}, roleRewards: {} };
let saveTimer = null;
let voiceTimer = null;
let dirty = false;
let discordClient = null;

function loadData() {
  const raw = loadJsonSync(DATA_FILE, { users: {}, roleRewards: {} });
  data = {
    users: raw.users || {},
    roleRewards: raw.roleRewards || {}
  };
}

function saveData() {
  saveJsonSync(DATA_FILE, data);
  dirty = false;
}

function markDirty() {
  dirty = true;
}

/**
 * XP required to complete a specific level (from level n to n+1).
 */
export function xpForLevel(n) {
  return 5 * n * n + 50 * n + 100;
}

/**
 * Total cumulative XP required to reach level n (from level 0).
 */
export function totalXpForLevel(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total += xpForLevel(i);
  }
  return total;
}

/**
 * Calculate level from total XP.
 */
function levelFromXp(xp) {
  let level = 0;
  let remaining = xp;
  while (remaining >= xpForLevel(level + 1)) {
    remaining -= xpForLevel(level + 1);
    level++;
  }
  return level;
}

/**
 * Get a user's progress within their current level.
 */
export function xpProgressInLevel(userId) {
  const user = data.users[userId];
  if (!user) return { currentXp: 0, requiredXp: xpForLevel(1), level: 0 };

  const totalForCurrentLevel = totalXpForLevel(user.level);
  const xpIntoLevel = user.xp - totalForCurrentLevel;
  const requiredXp = xpForLevel(user.level + 1);

  return { currentXp: xpIntoLevel, requiredXp, level: user.level };
}

/**
 * Get user level data.
 */
export function getUserLevel(userId) {
  return data.users[userId] || null;
}

/**
 * Get leaderboard sorted by XP.
 */
export function getLeaderboard(limit = 10) {
  return Object.entries(data.users)
    .sort(([, a], [, b]) => b.xp - a.xp)
    .slice(0, limit)
    .map(([userId, userData], index) => ({
      rank: index + 1,
      userId,
      displayName: userData.displayName,
      xp: userData.xp,
      level: userData.level
    }));
}

/**
 * Get rank position for a specific user.
 */
function getUserRank(userId) {
  const sorted = Object.entries(data.users)
    .sort(([, a], [, b]) => b.xp - a.xp);
  const index = sorted.findIndex(([id]) => id === userId);
  return index === -1 ? null : index + 1;
}

/**
 * Award XP and handle level-ups. Returns the new level if leveled up, null otherwise.
 */
function awardXp(userId, displayName, amount) {
  if (!data.users[userId]) {
    data.users[userId] = { displayName, xp: 0, level: 0, lastMessageXpAt: 0 };
  }

  data.users[userId].displayName = displayName;
  data.users[userId].xp += amount;

  const newLevel = levelFromXp(data.users[userId].xp);
  const oldLevel = data.users[userId].level;

  if (newLevel > oldLevel) {
    data.users[userId].level = newLevel;
    markDirty();
    return { oldLevel, newLevel };
  }

  markDirty();
  return null;
}

/**
 * Send level-up notification embed.
 */
async function sendLevelUpNotification(channel, userId, newLevel, member) {
  const progress = xpProgressInLevel(userId);
  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('Level Up!')
    .setDescription(`<@${userId}> reached **level ${newLevel}**!`)
    .addFields(
      { name: 'Total XP', value: `${data.users[userId].xp}`, inline: true },
      { name: 'Next Level', value: `${progress.currentXp}/${progress.requiredXp} XP`, inline: true }
    )
    .setThumbnail(member?.user?.displayAvatarURL({ size: 128 }) || null)
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error('[LevelSystem] Error sending level-up notification:', e.message);
  }
}

/**
 * Check and assign role rewards for a user.
 */
async function checkRoleRewards(member, newLevel) {
  if (!member || Object.keys(data.roleRewards).length === 0) return;

  for (const [levelStr, roleId] of Object.entries(data.roleRewards)) {
    const requiredLevel = parseInt(levelStr);
    if (newLevel >= requiredLevel && !member.roles.cache.has(roleId)) {
      try {
        await member.roles.add(roleId);
        console.log(`[LevelSystem] Assigned role ${roleId} to ${member.displayName} for reaching level ${requiredLevel}`);
      } catch (e) {
        console.error(`[LevelSystem] Error assigning role ${roleId}:`, e.message);
      }
    }
  }
}

/**
 * Handle message XP with cooldown.
 */
function handleMessageXp(message) {
  const userId = message.author.id;
  const displayName = message.member?.displayName || message.author.globalName || message.author.username;
  const now = Date.now();

  // Check cooldown
  const user = data.users[userId];
  if (user && (now - user.lastMessageXpAt) < MESSAGE_COOLDOWN_MS) return;

  // Set cooldown timestamp
  if (!data.users[userId]) {
    data.users[userId] = { displayName, xp: 0, level: 0, lastMessageXpAt: 0 };
  }
  data.users[userId].lastMessageXpAt = now;

  // Award random XP
  const amount = Math.floor(Math.random() * (MESSAGE_XP_MAX - MESSAGE_XP_MIN + 1)) + MESSAGE_XP_MIN;
  const levelUp = awardXp(userId, displayName, amount);

  if (levelUp) {
    // Always send level-up notifications to the general channel
    const generalChannel = message.guild?.channels.cache.get(GENERAL_CHANNEL_ID);
    sendLevelUpNotification(generalChannel || message.channel, userId, levelUp.newLevel, message.member);
    checkRoleRewards(message.member, levelUp.newLevel);
  }
}

/**
 * Scan voice channels and award voice XP.
 */
function awardVoiceXp() {
  if (!discordClient) return;

  const guild = discordClient.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) return;

  for (const [, channel] of guild.channels.cache) {
    if (!channel.isVoiceBased() || !channel.members) continue;

    // Count non-bot, non-deafened, non-AFK humans
    const eligibleMembers = channel.members.filter(m =>
      !m.user.bot && !m.voice.deaf && !m.voice.selfDeaf && m.voice.channelId !== guild.afkChannelId
    );

    // Skip channels with only 1 human (prevents AFK farming)
    if (eligibleMembers.size < 2) continue;

    for (const [memberId, member] of eligibleMembers) {
      const displayName = member.displayName || member.user.username;
      const levelUp = awardXp(memberId, displayName, VOICE_XP_PER_MINUTE);

      if (levelUp) {
        // For voice XP level-ups, post to general channel
        const notifChannel = guild.channels.cache.get(GENERAL_CHANNEL_ID);

        if (notifChannel) {
          sendLevelUpNotification(notifChannel, memberId, levelUp.newLevel, member);
        }
        checkRoleRewards(member, levelUp.newLevel);
      }
    }
  }
}

/**
 * Initialize the level system.
 */
export function initLevelSystem(client) {
  discordClient = client;
  loadData();

  // Listen for messages
  client.on('messageCreate', (message) => {
    if (message.author.bot || !message.guild) return;
    handleMessageXp(message);
  });

  // Voice XP interval
  voiceTimer = setInterval(awardVoiceXp, VOICE_CHECK_INTERVAL_MS);

  // Periodic save
  saveTimer = setInterval(() => {
    if (dirty) saveData();
  }, SAVE_INTERVAL_MS);

  console.log('[LevelSystem] Initialized');
}

/**
 * Stop the level system and save data.
 */
export function stopLevelSystem() {
  if (dirty) saveData();
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (voiceTimer) {
    clearInterval(voiceTimer);
    voiceTimer = null;
  }
}

export { getUserRank };
