import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'reminders.json');

let data = null;
let discordClient = null;
const activeTimeouts = new Map();

function load() {
  if (data !== null) return;
  data = loadJsonSync(DATA_FILE, { reminders: [] });
}

function save() {
  saveJsonSync(DATA_FILE, data);
}

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

// setTimeout with a delay beyond ~24.8 days (2^31-1 ms) overflows Node's signed
// 32-bit timer and fires immediately, so long waits are broken into <=24h hops.
const MAX_TIMEOUT_DELAY = 86_400_000; // 24h

export function nextTimeoutDelay(msRemaining) {
  return Math.min(Math.max(msRemaining, 0), MAX_TIMEOUT_DELAY);
}

// Date's constructor silently rolls invalid days/months into the next
// month/year (e.g. Feb 30 -> Mar 2), so validity is checked by round-tripping.
export function isValidCalendarDate(day, month, year) {
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

function scheduleReminder(reminder) {
  const msRemaining = reminder.fireAt - Date.now();
  const delay = nextTimeoutDelay(msRemaining);

  const timeout = setTimeout(() => {
    if (reminder.fireAt - Date.now() > 1000) {
      scheduleReminder(reminder);
    } else {
      fireReminder(reminder);
    }
  }, delay);
  activeTimeouts.set(reminder.id, timeout);
}

async function fireReminder(reminder) {
  activeTimeouts.delete(reminder.id);

  try {
    const channel = await discordClient.channels.fetch(reminder.channelId);
    if (!channel) {
      throw new Error(`Channel ${reminder.channelId} not found`);
    }

    const mentions = [`<@${reminder.userId}>`];
    if (reminder.mentions?.length > 0) {
      for (const userId of reminder.mentions) {
        mentions.push(`<@${userId}>`);
      }
    }
    if (reminder.roleMentions?.length > 0) {
      for (const roleId of reminder.roleMentions) {
        mentions.push(`<@&${roleId}>`);
      }
    }

    await channel.send(`${mentions.join(' ')} **Reminder:** ${reminder.message}`);
    console.log(`[ReminderTracker] Fired reminder ${reminder.id} for user ${reminder.userId}`);
    removeReminderFromData(reminder.id);
  } catch (e) {
    console.error(`[ReminderTracker] Error firing reminder ${reminder.id}:`, e.message);
    retryReminder(reminder);
  }
}

function retryReminder(reminder) {
  reminder.attempts = (reminder.attempts || 0) + 1;
  if (reminder.attempts < 3) {
    reminder.fireAt = Date.now() + 5 * 60_000;
    // Reminder may have been cancelled while delivery was in flight; don't resurrect it.
    if (!updateReminderInData(reminder)) return;
    scheduleReminder(reminder);
  } else {
    console.error(`[ReminderTracker] Giving up on reminder ${reminder.id} after 3 attempts`);
    removeReminderFromData(reminder.id);
  }
}

function updateReminderInData(reminder) {
  load();
  const idx = data.reminders.findIndex(r => r.id === reminder.id);
  if (idx === -1) return false;
  data.reminders[idx] = reminder;
  save();
  return true;
}

function removeReminderFromData(id) {
  load();
  data.reminders = data.reminders.filter(r => r.id !== id);
  save();
}

// === Public API ===

export function initReminderTracker(client) {
  discordClient = client;
  load();

  // Schedule all pending reminders
  let scheduled = 0;
  for (const reminder of data.reminders) {
    scheduleReminder(reminder);
    scheduled++;
  }

  if (scheduled > 0) {
    console.log(`[ReminderTracker] Scheduled ${scheduled} pending reminder(s)`);
  }
  console.log('[ReminderTracker] Initialized');
}

export function addReminder({ userId, channelId, guildId, message, fireAt, mentions, roleMentions }) {
  load();
  const id = generateId();
  const reminder = { id, userId, channelId, guildId, message, fireAt, mentions: mentions || [], roleMentions: roleMentions || [], createdAt: Date.now() };
  data.reminders.push(reminder);
  save();
  scheduleReminder(reminder);
  return id;
}

export function getUserReminders(userId) {
  load();
  return data.reminders.filter(r => r.userId === userId);
}

export function cancelReminder(userId, reminderId) {
  load();
  const reminder = data.reminders.find(r => r.id === reminderId && r.userId === userId);
  if (!reminder) return false;

  const timeout = activeTimeouts.get(reminderId);
  if (timeout) {
    clearTimeout(timeout);
    activeTimeouts.delete(reminderId);
  }

  data.reminders = data.reminders.filter(r => r.id !== reminderId);
  save();
  return true;
}
