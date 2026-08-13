import { EndBehaviorType, VoiceConnectionStatus } from '@discordjs/voice';
import prism from 'prism-media';
import { createWriteStream, createReadStream, mkdirSync } from 'fs';
import { stat, unlink } from 'fs/promises';
import { join } from 'path';

// Discord's native PCM format for received audio
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

// A forgotten recording must not run (and buffer/disk-write) forever
const MAX_RECORDING_MS = 30 * 60_000;

const recordings = new Map(); // guildId -> recording state

export function isRecording(guildId) {
  return recordings.has(guildId);
}

// Pure and exported so it can be unit-tested without touching Discord or the filesystem.
export function buildWavHeader(dataSize) {
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(dataSize + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

// Start recording a single target user's audio in the channel the given connection is in.
// channel (a Discord TextChannel) is used to announce auto-stop, since that fires on a
// timer with no interaction to reply to.
export function startRecording(connection, guild, targetId, invokerId, channel) {
  if (recordings.has(guild.id)) return false;

  const dir = join(process.cwd(), 'data', 'recordings');
  mkdirSync(dir, { recursive: true });

  const receiver = connection.receiver;
  const state = {
    connection,
    receiver,
    targetId,
    invokerId,
    channel,
    users: new Map(), // userId -> { opusStream, decoder, writeStream, pcmPath, wavPath, filename, username, displayName }
    speakingHandler: null,
    destroyedHandler: null,
    autoStopTimeout: null,
  };

  const onSpeaking = (userId) => {
    if (userId !== targetId) return;
    if (state.users.has(userId)) return; // already capturing this user

    const member = guild.members.cache.get(userId);
    if (!member || member.user.bot) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `${member.user.username}_${timestamp}`;
    const pcmPath = join(dir, `${baseName}.pcm`);
    const wavPath = join(dir, `${baseName}.wav`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    const writeStream = createWriteStream(pcmPath);

    opusStream.on('error', () => {}); // ignore receive errors
    decoder.on('error', () => {}); // ignore decode errors
    writeStream.on('error', (err) => console.error('[voiceRecorder] write stream error:', err.message));

    opusStream.pipe(decoder).pipe(writeStream);

    state.users.set(userId, {
      opusStream,
      decoder,
      writeStream,
      pcmPath,
      wavPath,
      filename: `${baseName}.wav`,
      username: member.user.username,
      displayName: member.displayName,
    });
  };

  receiver.speaking.on('start', onSpeaking);
  state.speakingHandler = onSpeaking;

  // If the connection dies (kicked, channel deleted, music queue tears it down, etc.)
  // finalize whatever was captured instead of leaving isRecording() stuck true forever.
  state.destroyedHandler = () => {
    finalize(guild.id).catch((err) => console.error('[voiceRecorder] finalize on connection destroy failed:', err.message));
  };
  connection.once(VoiceConnectionStatus.Destroyed, state.destroyedHandler);

  state.autoStopTimeout = setTimeout(() => {
    finalize(guild.id)
      .then(() => {
        if (channel) {
          channel.send(`⏹️ Recording of <@${targetId}> auto-stopped after 30 minutes.`).catch(() => {});
        }
      })
      .catch((err) => console.error('[voiceRecorder] auto-stop finalize failed:', err.message));
  }, MAX_RECORDING_MS);

  recordings.set(guild.id, state);
  return true;
}

// Manual stop, called from /record stop. Returns the list of saved files.
export async function stopRecording(guildId) {
  return finalize(guildId);
}

// Tears down listeners/timers/subscriptions and converts every captured user's .pcm into a
// playable .wav, streaming end-to-end (never buffering the whole recording in memory).
async function finalize(guildId) {
  const state = recordings.get(guildId);
  if (!state) return [];
  // Claim the state immediately so a concurrent manual stop / auto-stop / connection-destroy
  // can't both try to finalize the same recording.
  recordings.delete(guildId);

  if (state.autoStopTimeout) {
    clearTimeout(state.autoStopTimeout);
    state.autoStopTimeout = null;
  }
  if (state.speakingHandler) {
    state.receiver.speaking.off('start', state.speakingHandler);
  }
  if (state.destroyedHandler && state.connection) {
    state.connection.off(VoiceConnectionStatus.Destroyed, state.destroyedHandler);
  }

  const files = [];
  for (const userData of state.users.values()) {
    try {
      const result = await finalizeUserRecording(userData);
      if (result) files.push(result);
    } catch (err) {
      console.error('[voiceRecorder] failed to finalize recording for', userData.username, err.message);
    }
  }
  return files;
}

// Stops capture for one user, streams their .pcm into a .wav with a proper header, then
// deletes the .pcm. Returns null (and cleans up) if nothing was ever captured.
async function finalizeUserRecording(userData) {
  // Unpipe first so no queued 'data' event can call write() after we end() the stream below.
  userData.decoder.unpipe(userData.writeStream);
  try { userData.opusStream.destroy(); } catch {}
  try { userData.decoder.destroy(); } catch {}

  await new Promise((resolve) => {
    if (userData.writeStream.writableEnded || userData.writeStream.destroyed) return resolve();
    userData.writeStream.end(resolve);
  });

  const stats = await stat(userData.pcmPath).catch(() => null);
  if (!stats || stats.size === 0) {
    await unlink(userData.pcmPath).catch(() => {});
    return null;
  }

  await streamPcmToWav(userData.pcmPath, userData.wavPath, stats.size);
  await unlink(userData.pcmPath).catch(() => {});

  const durationSec = stats.size / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  return {
    username: userData.displayName,
    filename: userData.filename,
    filepath: userData.wavPath,
    duration: Math.round(durationSec),
  };
}

// Writes a WAV header followed by the raw PCM data, streaming the .pcm file straight through
// rather than reading it into memory.
function streamPcmToWav(pcmPath, wavPath, dataSize) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(wavPath);
    out.on('error', reject);
    out.write(buildWavHeader(dataSize), (err) => {
      if (err) return reject(err);
      const input = createReadStream(pcmPath);
      input.on('error', reject);
      out.on('finish', resolve);
      input.pipe(out);
    });
  });
}
