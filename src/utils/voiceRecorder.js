import { EndBehaviorType, getVoiceConnection, joinVoiceChannel } from '@discordjs/voice';
import prism from 'prism-media';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Only record these user IDs (whitelist)
const ALLOWED_USER_IDS = new Set([
  '189346966465937409',
]);

const recordings = new Map(); // guildId -> recording state

export function isRecording(guildId) {
  return recordings.has(guildId);
}

export function startRecording(connection, guild) {
  if (recordings.has(guild.id)) return false;

  const receiver = connection.receiver;
  const state = {
    users: new Map(),
    startTime: Date.now(),
    speakingHandler: null,
  };

  const onSpeaking = (userId) => {
    if (state.users.has(userId)) return;
    if (!ALLOWED_USER_IDS.has(userId)) return;

    const member = guild.members.cache.get(userId);
    if (!member || member.user.bot) return;

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks = [];

    opusStream.pipe(decoder);
    decoder.on('data', (chunk) => chunks.push(chunk));
    decoder.on('error', () => {}); // ignore decode errors

    state.users.set(userId, {
      opusStream,
      decoder,
      chunks,
      username: member.user.username,
      displayName: member.displayName,
    });
  };

  receiver.speaking.on('start', onSpeaking);
  state.speakingHandler = onSpeaking;

  recordings.set(guild.id, state);
  return true;
}

export function stopRecording(guildId) {
  const state = recordings.get(guildId);
  if (!state) return [];

  // Remove speaking listener
  // (VoiceReceiver.speaking is an EventEmitter, clean up our handler)
  state.speakingHandler = null;

  const dir = join(process.cwd(), 'data', 'recordings');
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const files = [];

  for (const [userId, userData] of state.users) {
    try {
      userData.opusStream.destroy();
    } catch {}
    try {
      userData.decoder.destroy();
    } catch {}

    const pcmData = Buffer.concat(userData.chunks);
    if (pcmData.length === 0) continue;

    const filename = `${userData.username}_${timestamp}.wav`;
    const filepath = join(dir, filename);

    writeWav(filepath, pcmData, 48000, 2, 16);

    const durationSec = pcmData.length / (48000 * 2 * 2); // sampleRate * channels * bytesPerSample
    files.push({
      username: userData.displayName,
      filename,
      filepath,
      duration: Math.round(durationSec),
    });
  }

  recordings.delete(guildId);
  return files;
}

function writeWav(filepath, pcmData, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  writeFileSync(filepath, Buffer.concat([header, pcmData]));
}
