import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EmbedBuilder } from 'discord.js';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'birthdays.json');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

let data = null;
let discordClient = null;
let scheduleTimeout = null;

function load() {
  if (data !== null) return;
  data = loadJsonSync(DATA_FILE, { birthdays: {}, channels: {} });
}

function save() {
  saveJsonSync(DATA_FILE, data);
}

function msUntilNext8AM() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function scheduleNext() {
  if (scheduleTimeout) {
    clearTimeout(scheduleTimeout);
    scheduleTimeout = null;
  }

  const ms = msUntilNext8AM();
  const hours = Math.round(ms / 3600000);
  console.log(`[BirthdayTracker] Next check in ~${hours} hours`);

  scheduleTimeout = setTimeout(fireBirthdayCheck, ms);
}

async function fireBirthdayCheck() {
  load();
  const now = new Date();
  const today = { day: now.getDate(), month: now.getMonth() + 1 };

  const birthdayUsers = Object.entries(data.birthdays)
    .filter(([, b]) => b.day === today.day && b.month === today.month)
    .map(([userId, b]) => ({ userId, displayName: b.displayName }));

  if (birthdayUsers.length > 0) {
    for (const [guildId, channelId] of Object.entries(data.channels)) {
      try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) continue;

        const mentions = birthdayUsers.map(u => `<@${u.userId}>`).join(', ');
        const embed = new EmbedBuilder()
          .setColor(0xFF69B4)
          .setTitle('🎂 Happy Birthday!')
          .setDescription(birthdayUsers.length === 1
            ? `It's ${mentions}'s birthday today! Wish them a happy birthday! 🎉`
            : `It's a special day! Happy birthday to ${mentions}! 🎉`)
          .setTimestamp();

        await channel.send({ embeds: [embed] });
        console.log(`[BirthdayTracker] Posted birthday announcement for ${birthdayUsers.length} user(s) in guild ${guildId}`);
      } catch (e) {
        console.error(`[BirthdayTracker] Error posting to guild ${guildId}:`, e.message);
      }
    }
  }

  scheduleNext();
}

// === Public API ===

export function initBirthdayTracker(client) {
  discordClient = client;
  load();
  scheduleNext();
  console.log('[BirthdayTracker] Initialized');
}

export function setBirthday(userId, day, month, displayName) {
  load();
  data.birthdays[userId] = { day, month, displayName };
  save();
}

export function removeBirthday(userId) {
  load();
  if (!data.birthdays[userId]) return false;
  delete data.birthdays[userId];
  save();
  return true;
}

export function getBirthdays() {
  load();
  return data.birthdays;
}

export function getBirthdayChannel(guildId) {
  load();
  return data.channels[guildId] || null;
}

export function setBirthdayChannel(guildId, channelId) {
  load();
  data.channels[guildId] = channelId;
  save();
}
