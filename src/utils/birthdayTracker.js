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

// Wraps scheduleNext() so a startup failure doesn't leave the birthday
// scheduler permanently dead — retries in 1h.
function scheduleNextSafe() {
  try {
    scheduleNext();
  } catch (e) {
    console.error('[BirthdayTracker] Failed to schedule next check, retrying in 1h:', e.message);
    scheduleTimeout = setTimeout(scheduleNextSafe, 60 * 60 * 1000);
  }
}

/**
 * Whether `year` is a leap year (Gregorian calendar rules).
 */
export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

async function fireBirthdayCheck() {
  try {
    load();
    const now = new Date();
    const today = { day: now.getDate(), month: now.getMonth() + 1 };
    // In non-leap years, Feb 29 birthdays are celebrated on Feb 28 instead.
    const isFeb28NonLeap = today.day === 28 && today.month === 2 && !isLeapYear(now.getFullYear());

    const birthdayUsers = Object.entries(data.birthdays)
      .filter(([, b]) => (b.day === today.day && b.month === today.month) ||
        (isFeb28NonLeap && b.day === 29 && b.month === 2))
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
  } catch (e) {
    console.error('[BirthdayTracker] Error during birthday check:', e.message);
  } finally {
    // Schedule next — always, even if the run above failed
    scheduleNext();
  }
}

// === Public API ===

export function initBirthdayTracker(client) {
  discordClient = client;
  load();
  scheduleNextSafe();
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
