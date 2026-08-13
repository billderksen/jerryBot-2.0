import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import { startRecording, stopRecording, isRecording } from '../utils/voiceRecorder.js';
import { getQueue } from '../utils/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription('Record a user\'s voice channel audio (requires Manage Server)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start recording a user in your voice channel')
        .addUserOption(opt =>
          opt.setName('target')
            .setDescription('The user to record')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('Stop recording and save the .wav file')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // Defense in depth: setDefaultMemberPermissions hides the command from members without
    // Manage Server in Discord's UI, but doesn't stop it being invoked if that gets misconfigured.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'You need the **Manage Server** permission to use this command.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'start') {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel) {
        return interaction.reply({
          content: 'You need to be in a voice channel.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (isRecording(guildId)) {
        return interaction.reply({
          content: 'Already recording. Use `/record stop` to finish.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const target = interaction.options.getUser('target', true);
      const targetMember = interaction.guild.members.cache.get(target.id)
        ?? await interaction.guild.members.fetch(target.id).catch(() => null);

      if (!targetMember || targetMember.voice.channelId !== voiceChannel.id) {
        return interaction.reply({
          content: `${target} needs to be in **${voiceChannel.name}** with you to be recorded.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      // Connection ownership: never yank the connection out from under the music queue, and
      // never blindly rejoin over an existing connection that's active in another channel.
      const existingConnection = getVoiceConnection(guildId);
      let connection;

      if (existingConnection && existingConnection.joinConfig.channelId !== voiceChannel.id) {
        const otherChannel = interaction.guild.channels.cache.get(existingConnection.joinConfig.channelId);
        return interaction.reply({
          content: `I'm already active in **${otherChannel?.name ?? 'another channel'}**. Join me there, or wait until that session ends.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (existingConnection) {
        // Same channel - reuse the connection instead of rejoining.
        if (existingConnection.joinConfig.selfDeaf) {
          const musicQueue = getQueue(guildId);
          if (musicQueue?.isPlaying) {
            return interaction.reply({
              content: `Music is playing in **${voiceChannel.name}** and I'm self-deafened, so I can't hear anything to record. Stop the music first, then try again.`,
              flags: MessageFlags.Ephemeral,
            });
          }
          // Nothing is playing, so it's safe to rejoin undeafened so the receiver can hear audio.
          connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
          });
        } else {
          connection = existingConnection;
        }
      } else {
        connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfDeaf: false,
        });
      }

      const started = startRecording(connection, interaction.guild, target.id, interaction.user.id, interaction.channel);

      // startRecording()'s return value is authoritative, not the isRecording() check above:
      // two concurrent /record start calls can both pass that check before either reaches here
      // (there's an await for the member fetch in between), but startRecording() claims the
      // guildId synchronously with no await before its own guard, so only one caller can ever
      // get `true`. Trusting the return value here — instead of the earlier check — is what
      // closes the race; without it the loser would still post a start announcement for a
      // recording it never actually started.
      if (!started) {
        return interaction.reply({
          content: 'Already recording. Use `/record stop` to finish.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Non-ephemeral and on purpose: recording someone without a visible notice is exactly
      // what this fix addresses, so everyone in the channel/thread sees this announcement.
      return interaction.reply(`🔴 Recording started for ${target} by ${interaction.user}.`);
    }

    if (sub === 'stop') {
      if (!isRecording(guildId)) {
        return interaction.reply({
          content: 'Not currently recording.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply();

      const files = await stopRecording(guildId);

      if (files.length === 0) {
        return interaction.editReply(`⏹️ Recording stopped by ${interaction.user}. No audio was captured.`);
      }

      const summary = files
        .map(f => `**${f.username}** — ${f.filename} (${f.duration}s)`)
        .join('\n');

      return interaction.editReply(
        `⏹️ Recording stopped by ${interaction.user}. Saved ${files.length} file(s) to \`data/recordings/\`:\n${summary}`
      );
    }
  },
};
