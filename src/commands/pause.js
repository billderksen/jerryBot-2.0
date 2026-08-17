import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';
import { logCommandAction } from '../utils/activityLogger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the currently playing song'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue || !queue.isPlaying) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    // pause() only actually pauses a player that is exactly Playing. Saying "paused" when it
    // was not is the lie users hit most often: /pause in the first seconds after /play is
    // exactly when someone realises they picked the wrong song, and the audio has not started
    // yet at that point.
    const result = queue.pause();

    // Log the action
    logCommandAction(interaction.user, 'pause');

    if (result.paused) {
      const message = result.reason === 'held-until-clip-ends'
        ? '⏸️ Paused the music — it stays paused once Jerry has finished talking.'
        : '⏸️ Paused the music.';
      return await interaction.reply(message);
    }

    const excuses = {
      loading: '⏳ That song is still loading — nothing to pause yet.',
      'already-paused': '⏸️ The music is already paused.',
      'no-voice': '❌ The voice connection is down, so the music is already stopped.',
      'nothing-playing': '❌ Nothing is currently playing!'
    };
    await interaction.reply({
      content: excuses[result.reason] || '❌ Could not pause the music right now.',
      flags: MessageFlags.Ephemeral
    });
  }
};
