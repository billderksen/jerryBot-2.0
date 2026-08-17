import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';
import { logCommandAction } from '../utils/activityLogger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    // unpause() only un-pauses a player that is actually Paused, so a queue that exists but is
    // idle - or one whose song is still downloading - answers false here
    const result = queue.resume();

    // Log the action
    logCommandAction(interaction.user, 'resume');

    if (result.resumed) {
      return await interaction.reply('▶️ Resumed the music.');
    }

    const excuses = {
      loading: '⏳ That song is still loading — it will start on its own.',
      'not-paused': '▶️ The music is already playing.',
      'no-voice': '❌ The voice connection is down — nothing to resume onto.',
      'nothing-playing': '❌ Nothing is currently playing!'
    };
    await interaction.reply({
      content: excuses[result.reason] || '❌ Could not resume the music right now.',
      flags: MessageFlags.Ephemeral
    });
  }
};
