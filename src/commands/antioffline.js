import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadJsonSync, saveJsonSync } from '../utils/jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '../../data/antioffline.json');

// Persisted state per guild: { guildId: { enabled: boolean, enabledBy: string } }
const antiOfflineState = new Map();

function load() {
  const raw = loadJsonSync(DATA_FILE, {});
  for (const [guildId, state] of Object.entries(raw)) {
    antiOfflineState.set(guildId, state);
  }
}

function save() {
  const obj = {};
  for (const [guildId, state] of antiOfflineState) {
    obj[guildId] = state;
  }
  saveJsonSync(DATA_FILE, obj);
}

// Load on import
load();

export function getAntiOfflineState(guildId) {
  return antiOfflineState.get(guildId) || { enabled: false, enabledBy: null };
}

const GENERAL_CHANNEL_ID = '1419789649873735680';

/**
 * Scan all voice channels in a guild and kick offline members.
 */
async function kickOfflineVoiceMembers(guild, enabledBy) {
  const kicked = [];
  for (const [, channel] of guild.channels.cache) {
    if (channel.type !== 2) continue; // 2 = GuildVoice
    for (const [, member] of channel.members) {
      if (member.user.bot) continue;
      const presence = member.presence;
      if (!presence || presence.status === 'offline') {
        try {
          await member.voice.disconnect();
          kicked.push(member.id);
        } catch (e) {
          console.error('[AntiOffline] Scan kick error:', e.message);
        }
      }
    }
  }
  if (kicked.length > 0) {
    const generalChannel = guild.channels.cache.get(GENERAL_CHANNEL_ID);
    if (generalChannel) {
      const mentions = kicked.map(id => `<@${id}>`).join(', ');
      await generalChannel.send(`${mentions} ${kicked.length === 1 ? 'is' : 'zijn'} gekickt uit het voice kanaal — anti-offline modus staat aan, aangezet door ${enabledBy}.`);
    }
  }
  return kicked.length;
}

export default {
  data: new SlashCommandBuilder()
    .setName('antioffline')
    .setDescription('Toggle anti-offline mode — deletes messages from users with offline status')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = interaction.guild.id;
    const current = getAntiOfflineState(guildId);

    if (current.enabled) {
      // Turn off
      antiOfflineState.set(guildId, { enabled: false, enabledBy: null });
      save();
      await interaction.editReply('Anti-offline modus is **uitgeschakeld**.');
    } else {
      // Turn on
      const displayName = interaction.member.displayName;
      antiOfflineState.set(guildId, { enabled: true, enabledBy: displayName });
      save();

      // Kick anyone currently in voice who is offline
      const kickedCount = await kickOfflineVoiceMembers(interaction.guild, displayName);
      const extra = kickedCount > 0 ? ` ${kickedCount} ${kickedCount === 1 ? 'persoon' : 'personen'} uit voice gekickt.` : '';
      await interaction.editReply(`Anti-offline modus is **ingeschakeld** door ${displayName}.${extra}`);
    }
  }
};
