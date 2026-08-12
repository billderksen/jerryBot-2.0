import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'reminders.json');

let data = null;
let discordClient = null;
const activeTimeouts = new Map();

function load() {
  if (data !== null) return;
  try {
    if (existsSync(DATA_FILE)) {
      data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    } else {
      data = { reminders: [] };
    }
  } catch (error) {
    console.error('[ReminderTracker] Error loading data:', error.message);
    data = { reminders: [] };
  }
}

function save() {
  try {
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[ReminderTracker] Error saving data:', error.message);
  }
}

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

function scheduleReminder(reminder) {
  const ms = reminder.fireAt - Date.now();
  if (ms <= 0) {
    // Already past, fire immediately
    fireReminder(reminder);
    return;
  }

  const timeout = setTimeout(() => fireReminder(reminder), ms);
  activeTimeouts.set(reminder.id, timeout);
}

async function fireReminder(reminder) {
  activeTimeouts.delete(reminder.id);

  try {
    const channel = await discordClient.channels.fetch(reminder.channelId);
    if (!channel) {
      console.error(`[ReminderTracker] Channel ${reminder.channelId} not found`);
      removeReminderFromData(reminder.id);
      return;
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
  } catch (e) {
    console.error(`[ReminderTracker] Error firing reminder ${reminder.id}:`, e.message);
  }

  removeReminderFromData(reminder.id);
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
