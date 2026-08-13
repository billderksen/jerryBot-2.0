import { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import {
  isOptedIn,
  setOptIn,
  syncSubscriptions,
  isVoiceAssistantEnabled,
} from '../utils/voiceAssistant.js';
import { getVoiceConfig, setVoiceSpokenReplies } from '../utils/openrouter.js';

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
    )
    .addSubcommand(sub =>
      sub.setName('replies')
        .setDescription('Toggle whether Jerry speaks his replies out loud (requires Manage Server)')
        .addStringOption(opt =>
          opt.setName('state')
            .setDescription('Speak replies out loud, or only report in the activity log')
            .setRequired(true)
            .addChoices(
              { name: 'on', value: 'on' },
              { name: 'off', value: 'off' },
            ))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'replies') {
      // Server-wide setting, unlike on/off/status which are personal opt-in -
      // gated at runtime only (the command itself has no default permission
      // restriction, since on/off/status must stay open to everyone).
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need the **Manage Server** permission to use this command.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const spoken = interaction.options.getString('state', true) === 'on';
      setVoiceSpokenReplies(spoken);

      return interaction.reply({
        content: spoken
          ? '🔊 Jerry now speaks his replies out loud in voice channels, in addition to the activity-log embed.'
          : '🔇 Jerry now only reports his replies in the activity-log embed (the wake beep still plays).',
        flags: MessageFlags.Ephemeral,
      });
    }

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
        { name: 'Spoken replies', value: getVoiceConfig().spokenReplies ? '✅ On' : '❌ Off', inline: true },
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
