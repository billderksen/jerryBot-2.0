import { SlashCommandBuilder, MessageFlags, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { VoiceConnectionStatus, entersState, getVoiceConnection } from '@discordjs/voice';
import {
  isOptedIn,
  setOptIn,
  syncSubscriptions,
  isVoiceAssistantEnabled,
  isWakeEngineDead,
  joinForListening,
  leaveVoiceChannel,
} from '../utils/voiceAssistant.js';
import { getVoiceConfig, setVoiceSpokenReplies } from '../utils/openrouter.js';
import { getQueue } from '../utils/musicQueue.js';
import { isRecording } from '../utils/voiceRecorder.js';

// How long to wait for the summoned connection to go Ready before giving up and
// hanging it up again. Generous: a slow voice region handshake is not a failure,
// but a connection that never arrives must not be left sitting there.
const JOIN_TIMEOUT_MS = 15_000;

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
      sub.setName('join').setDescription('Bring Jerry into your voice channel to listen (no music)')
    )
    .addSubcommand(sub =>
      sub.setName('leave').setDescription('Send Jerry out of the voice channel')
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

    if (sub === 'join') {
      // A summon is only worth anything if the assistant can actually hear a wake
      // word: no Groq key/models means it never started, a dead sidecar means it
      // stopped listening. Either way the bot would just sit there.
      if (!isVoiceAssistantEnabled() || isWakeEngineDead()) {
        return interaction.reply({
          content: isWakeEngineDead()
            ? '⚠️ The wake-word engine has stopped, so Jerry can\'t hear **"Hey Jerry"** until the bot restarts. Bringing him in would just leave him idling.'
            : '⚠️ The voice assistant is not running right now (missing API key or voice tools), so there is nothing to listen with.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const channel = interaction.member?.voice?.channel;
      if (!channel) {
        return interaction.reply({
          content: 'You need to be in a voice channel — that\'s the one I\'d join.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Consent first: Jerry never subscribes to anyone who hasn't opted in, so
      // summoning him without that would put a bot in the channel that is not
      // allowed to hear the person who asked for it.
      if (!isOptedIn(userId)) {
        return interaction.reply({
          content: 'Jerry may not listen to you yet, so bringing him in wouldn\'t do anything: he only ever hears members who ran `/heyjerry on`. Run that first, then `/heyjerry join`.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (!channel.joinable) {
        return interaction.reply({
          content: `I don't have permission to join **${channel.name}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // One connection per guild: joining from here while something else is using
      // one in ANOTHER channel would drag that session along with it (same rule
      // /record start follows).
      const existing = getVoiceConnection(interaction.guildId);
      if (existing && existing.joinConfig.channelId !== channel.id) {
        const otherChannel = interaction.guild.channels.cache.get(existing.joinConfig.channelId);
        const where = otherChannel ? `**${otherChannel.name}**` : 'another channel';
        const queue = getQueue(interaction.guildId);
        const reason = isRecording(interaction.guildId)
          ? `I'm recording in ${where} right now — join me there, or wait for \`/record stop\`.`
          : queue?.connection === existing
            ? `I'm playing music in ${where} — join me there, or stop it with \`/stop\` first.`
            : `I'm already active in ${where} — join me there, or wait until that session ends.`;
        return interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
      }

      if (existing) {
        // Same channel: there is nothing to join. Whoever brought the bot here
        // keeps the connection, and the sync below is the whole job - it undeafens
        // for an opted-in member if that hasn't happened yet.
        await syncSubscriptions(interaction.guildId);
        return interaction.reply(`🎙️ Already listening in **${channel.name}**.`);
      }

      await interaction.deferReply();
      let connection = null;
      try {
        connection = joinForListening(channel);
        await entersState(connection, VoiceConnectionStatus.Ready, JOIN_TIMEOUT_MS);
      } catch (err) {
        console.error('[heyjerry] could not join the voice channel:', err.message);
        // Don't leave a half-open connection behind for the assistant to sit on.
        // Identity-checked: another command may have claimed the guild meanwhile.
        if (connection && getVoiceConnection(interaction.guildId) === connection
            && connection.state.status !== VoiceConnectionStatus.Destroyed) {
          try { connection.destroy(); } catch { /* already gone */ }
        }
        return interaction.editReply(`❌ I couldn't connect to **${channel.name}**. Try again in a moment.`);
      }

      // Non-ephemeral on purpose: a bot that can hear the channel is something
      // everyone in it should see, the same way /record announces itself.
      return interaction.editReply(
        `🎙️ Listening in **${channel.name}**. Say **"Hey Jerry"**, wait for the beep, then give your command (in Dutch).`
      );
    }

    if (sub === 'leave') {
      const connection = getVoiceConnection(interaction.guildId);
      if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
        return interaction.reply({
          content: 'I\'m not in a voice channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const botChannelId = connection.joinConfig.channelId;
      const botChannel = interaction.guild.channels.cache.get(botChannelId);
      const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      // Anyone Jerry is actually listening to can send him away; from outside the
      // channel it takes Manage Server, so a passer-by can't hang up on a session
      // they aren't part of.
      if (!canManage && !(interaction.member?.voice?.channelId === botChannelId && isOptedIn(userId))) {
        return interaction.reply({
          content: `Only opted-in members in **${botChannel?.name ?? 'my voice channel'}** (or someone with **Manage Server**) can send me away.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // The music queue and /record each own their connection's lifecycle and
      // clean up after themselves - hanging up underneath either one would cut a
      // song off mid-play or truncate a recording.
      const queue = getQueue(interaction.guildId);
      if (queue && (queue.isPlaying || queue.songs.length > 0)) {
        return interaction.reply({
          content: 'Music is playing — use `/stop` instead, that stops the music and disconnects me.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (isRecording(interaction.guildId)) {
        return interaction.reply({
          content: 'A recording is running — use `/record stop` first, so the file gets saved.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // An idle queue can still be holding this connection - the 60s empty-queue
      // timer hasn't fired yet, or 24/7 mode means it never will. Hand the hang-up
      // to the queue in that case (the same queue.leave() /stop runs) rather than
      // destroying it underneath: cleanup() is what nulls queue.connection, and a
      // queue left pointing at a destroyed connection makes the next /play skip
      // its join and play into a socket that is gone.
      if (queue?.connection === connection) {
        queue.leave();
      } else {
        leaveVoiceChannel(interaction.guildId);
      }
      return interaction.reply(`👋 Left **${botChannel?.name ?? 'the voice channel'}**.`);
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
