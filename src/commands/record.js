import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getVoiceConnection, joinVoiceChannel } from '@discordjs/voice';
import { startRecording, stopRecording, isRecording } from '../utils/voiceRecorder.js';

export default {
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription('Record voice channel audio')
    .addSubcommand(sub =>
      sub.setName('start').setDescription('Start recording the voice channel')
    )
    .addSubcommand(sub =>
      sub.setName('stop').setDescription('Stop recording and save .wav files')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

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

      // Join (or rejoin) with selfDeaf: false so the bot can receive audio
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      startRecording(connection, interaction.guild);

      return interaction.reply({
        content: `Recording started in **${voiceChannel.name}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'stop') {
      if (!isRecording(guildId)) {
        return interaction.reply({
          content: 'Not currently recording.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const files = stopRecording(guildId);

      if (files.length === 0) {
        return interaction.editReply('Recording stopped. No audio was captured.');
      }

      const summary = files
        .map(f => `**${f.username}** — ${f.filename} (${f.duration}s)`)
        .join('\n');

      return interaction.editReply(
        `Recording stopped. Saved ${files.length} file(s) to \`data/recordings/\`:\n${summary}`
      );
    }
  },
};
