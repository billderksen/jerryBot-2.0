import { SlashCommandBuilder, MessageFlags, EmbedBuilder } from 'discord.js';
import {
  isOptedIn,
  setOptIn,
  syncSubscriptions,
  isVoiceAssistantEnabled,
} from '../utils/voiceAssistant.js';

// Opting in is what makes the bot listen to you at all - there is no way to be
// heard by "Hey Jerry" without running /heyjerry on first, and opting out takes
// effect immediately (the subscription is torn down before this replies).
export default {
  data: new SlashCommandBuilder()
    .setName('heyjerry')
    .setDescription('Manage whether Jerry listens to you for "Hey Jerry" voice commands')
    .addSubcommand(sub =>
      sub.setName('on').setDescription('Let Jerry listen to you in voice channels')
    )
    .addSubcommand(sub =>
      sub.setName('off').setDescription('Stop Jerry from listening to you')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Show your opt-in state and who else is opted in here')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'on' || sub === 'off') {
      const optIn = sub === 'on';
      setOptIn(userId, optIn);
      // Subscribe/unsubscribe before confirming, so the reply is only ever sent
      // once the change is actually in effect.
      await syncSubscriptions(interaction.guildId);

      const note = isVoiceAssistantEnabled()
        ? ''
        : '\n\n⚠️ The voice assistant is not running right now (missing API key or voice tools), but your preference is saved.';

      return interaction.reply({
        content: optIn
          ? `🎤 Jerry now listens to you in voice channels. Say **"Hey Jerry"**, wait for the beep, then give your command (in Dutch).${note}`
          : `🔇 Jerry no longer listens to you. Run \`/heyjerry on\` whenever you want it back.${note}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // status
    const voiceChannel = interaction.member?.voice?.channel;
    const listeners = voiceChannel
      ? [...voiceChannel.members.values()].filter(m => !m.user.bot && isOptedIn(m.id))
      : [];

    const embed = new EmbedBuilder()
      .setTitle('🎤 Hey Jerry')
      .setColor(isOptedIn(userId) ? 0x57f287 : 0x99aab5)
      .addFields(
        { name: 'You', value: isOptedIn(userId) ? '✅ Opted in' : '❌ Opted out', inline: true },
        { name: 'Assistant', value: isVoiceAssistantEnabled() ? '✅ Running' : '⚠️ Not running', inline: true },
        {
          name: voiceChannel ? `Opted in — ${voiceChannel.name}` : 'Opted in here',
          value: !voiceChannel
            ? '*You are not in a voice channel.*'
            : listeners.length > 0
              ? listeners.map(m => `• ${m.displayName}`).join('\n')
              : '*Nobody in this channel is opted in.*',
        },
      )
      .setFooter({ text: 'Jerry only ever listens to members who opted in with /heyjerry on.' });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
