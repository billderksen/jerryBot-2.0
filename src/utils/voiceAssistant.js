// "Hey Jerry" voice assistant - the orchestrator that ties the speech stack
// (src/utils/speech/*) to the bot's existing music/reminder/AI plumbing.
//
// Flow:
//   opted-in member speaks -> receiver subscription -> opus decode (48k stereo)
//   -> downsample to 16k mono -> wake-word sidecar -> 'wake' event
//   -> beep -> record the utterance -> Groq Whisper -> intent -> dispatch
//   -> spoken Dutch reply (Piper, ducked over the music) + an embed in the
//      activity-log channel.
//
// THE CONSENT INVARIANT: the bot only ever subscribes to the audio of members
// who explicitly opted in with /heyjerry on, and only while they are in the
// channel the bot is sitting in. Every subscription in this module is created
// by syncSubscriptions() (and the capture that a wake event triggers for the
// user who woke it) - nothing else may call receiver.subscribe(). Opt-in state
// is re-checked at wake time and again after capture, so someone who opts out
// mid-utterance never has their audio sent to a transcription API.
//
// The bot self-deafens by default (musicQueue's joinVoiceChannel leaves
// selfDeaf at its `true` default), which means it receives no audio at all.
// It is rejoined undeafened while at least one opted-in member is in the
// channel, and re-deafened when the last one leaves or opts out.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbedBuilder, Events } from 'discord.js';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import prism from 'prism-media';

import { loadJsonSync, saveJsonSync } from './jsonStore.js';
import { WakewordEngine } from './speech/wakeword.js';
import { transcribe } from './speech/transcribe.js';
import { parseIntent } from './speech/intent.js';
import { speak, playBeep, isTtsAvailable } from './speech/tts.js';
import { addReminder } from './reminderTracker.js';
import { chatWithAI, getChatConfig } from './openrouter.js';
import { getLogChannelId } from './activityLogger.js';
import { sanitizeSearchQuery } from './urlValidation.js';
import { isRecording } from './voiceRecorder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_PATH = path.join(__dirname, '..', '..', 'data', 'voiceAssistant.json');

// Discord's native receive format
const IN_SAMPLE_RATE = 48000;
const IN_CHANNELS = 2;
const OUT_SAMPLE_RATE = 16000; // what openWakeWord and Whisper both want

const MAX_SLOTS = 16; // must match the sidecar's slot count

const WAKE_LIMIT = 10; // wakes per guild ...
const WAKE_WINDOW_MS = 60_000; // ... per this window
const MAX_CONCURRENT_PER_GUILD = 2;

const CAPTURE_SILENCE_MS = 1000; // end the utterance after this much silence
const CAPTURE_MAX_MS = 10_000; // hard cap: a stream that never goes silent must still end
const CAPTURE_MAX_BYTES = (CAPTURE_MAX_MS / 1000) * IN_SAMPLE_RATE * IN_CHANNELS * 2;
const MIN_CAPTURE_BYTES = OUT_SAMPLE_RATE * 2 * 0.3; // <0.3s of speech is not worth an API call

const SPOKEN_ANSWER_MAX_CHARS = 400;
const AUTO_LEAVE_DEFER_MS = 60_000;
const RECONCILE_INTERVAL_MS = 30_000;

const ERROR_REPLY = 'Sorry, dat verstond ik niet.';

// Where reminders created by voice are posted - same channel index.js uses.
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID || '1419789649873735680';

// ---------------------------------------------------------------------------
// Opt-in store (data/voiceAssistant.json)
// ---------------------------------------------------------------------------

let storePath = DEFAULT_STORE_PATH;
let store = null;

function loadStore() {
  if (store === null) {
    store = loadJsonSync(storePath, { optedIn: {} });
    if (!store.optedIn || typeof store.optedIn !== 'object') store.optedIn = {};
  }
  return store;
}

function saveStore() {
  if (store !== null) saveJsonSync(storePath, store);
}

/** Test seam: point the opt-in store at another file. Production uses data/voiceAssistant.json. */
export function setOptInStorePath(filePath) {
  storePath = filePath;
  store = null;
}

/** Drop the in-memory copy so the next read comes off disk. */
export function reloadOptIns() {
  store = null;
}

/** @returns {boolean} whether this user consented to being listened to. */
export function isOptedIn(userId) {
  return Boolean(loadStore().optedIn[userId]);
}

/** Opt a user in or out, persisting immediately (this is consent - it must survive a crash). */
export function setOptIn(userId, optedIn) {
  const data = loadStore();
  if (optedIn) {
    data.optedIn[userId] = { since: new Date().toISOString() };
  } else {
    delete data.optedIn[userId];
  }
  saveStore();
  return optedIn;
}

/** @returns {string[]} every user id currently opted in. */
export function getOptedInUserIds() {
  return Object.keys(loadStore().optedIn);
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/**
 * 48kHz stereo (interleaved L,R) -> 16kHz mono: average the two channels and
 * keep every 3rd frame. Cheap decimation without a low-pass filter, which is
 * fine here because both consumers (openWakeWord, Whisper) work on speech that
 * carries almost no energy above 8kHz.
 * @param {Int16Array} int16Interleaved
 * @returns {Int16Array} floor(frames / 3) mono samples
 */
export function downsample48kStereoTo16kMono(int16Interleaved) {
  const frames = int16Interleaved.length >> 1;
  const outLength = Math.floor(frames / 3);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const base = i * 3 * IN_CHANNELS;
    // >>1 rather than /2: floor division that stays inside Int16 for every
    // input pair, including (-32768 + -32768).
    out[i] = (int16Interleaved[base] + int16Interleaved[base + 1]) >> 1;
  }
  return out;
}

// Buffer -> Int16Array. Reads explicitly little-endian rather than casting a
// typed-array view over the buffer: views inherit platform endianness and can
// only be created on an even byteOffset, neither of which is guaranteed here.
function bufferToInt16(buf) {
  const samples = buf.length >> 1;
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function int16ToBuffer(samples) {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

function createDecoder() {
  return new prism.opus.Decoder({ rate: IN_SAMPLE_RATE, channels: IN_CHANNELS, frameSize: 960 });
}

// Destroy a receive stream and wait for its 'close', which is what makes the
// receiver drop it from receiver.subscriptions. That matters because
// receiver.subscribe() hands back the EXISTING stream for a user if there is
// one - re-subscribing before the old stream closed would silently reuse it.
function destroyStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 200);
    stream.once('close', finish);
    try {
      stream.destroy();
    } catch {
      finish();
    }
  });
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let client = null;
let engine = null;
let started = false;
let voiceStateHandler = null;
let reconcileTimer = null;
let runMusicCommand = null; // index.js's web-dashboard command handler
let addSongToQueue = null; // index.js's web-dashboard add-song handler

// slot -> { guildId, userId, assignedAt }. Slots are global because the sidecar
// only has MAX_SLOTS models to hand out, across every guild.
const slotOwners = new Array(MAX_SLOTS).fill(null);

// guildId -> guild state
const guildStates = new Map();

function getGuildState(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
    state = {
      guildId,
      connection: null,
      stateHandler: null,
      monitors: new Map(), // userId -> { slot, opusStream, decoder, onData, stopped }
      capturing: new Set(), // users whose monitor is on hold while we record them
      active: new Set(), // users with a pipeline in flight
      wakeTimes: [], // wake timestamps, for the per-guild rate limit
      chain: Promise.resolve(), // serializes subscription bookkeeping
    };
    guildStates.set(guildId, state);
  }
  return state;
}

// All subscription bookkeeping for a guild runs on one chain: syncs triggered
// by a voice state update, a connection going Ready and an opt-in toggle can
// otherwise interleave and double-subscribe.
function enqueue(state, job) {
  state.chain = state.chain
    .then(job)
    .catch((err) => console.error('[VoiceAssistant] subscription bookkeeping failed:', err.message));
  return state.chain;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function releaseSlotAt(index) {
  if (slotOwners[index] === null) return;
  slotOwners[index] = null;
  engine?.releaseSlot(index);
}

function acquireSlot(guildId, userId) {
  const existing = slotOwners.findIndex((o) => o && o.guildId === guildId && o.userId === userId);
  if (existing !== -1) return existing;

  let index = slotOwners.indexOf(null);
  if (index === -1) {
    // Full: evict the least recently assigned slot.
    let oldest = 0;
    for (let i = 1; i < MAX_SLOTS; i++) {
      if (slotOwners[i].assignedAt < slotOwners[oldest].assignedAt) oldest = i;
    }
    const victim = slotOwners[oldest];
    console.warn(`[VoiceAssistant] All ${MAX_SLOTS} wake-word slots in use, evicting user ${victim.userId}`);
    releaseSlotAt(oldest); // also resets the sidecar's model state for the slot
    stopMonitoring(victim.guildId, victim.userId, { keepSlot: true })
      .catch((err) => console.error('[VoiceAssistant] evicting a slot failed:', err.message));
    index = oldest;
  }

  slotOwners[index] = { guildId, userId, assignedAt: Date.now() };
  return index;
}

// ---------------------------------------------------------------------------
// Subscriptions (THE consent invariant lives here)
// ---------------------------------------------------------------------------

function startMonitoring(state, userId) {
  const connection = state.connection;
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) return;
  if (state.monitors.has(userId) || state.capturing.has(userId)) return;
  // doSync only ever passes opted-in users, but the guard sits here too so that
  // every receiver.subscribe() in this file is consent-checked in its own frame.
  if (!isOptedIn(userId)) return;

  const slot = acquireSlot(state.guildId, userId);
  const opusStream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
  const decoder = createDecoder();
  const monitor = { slot, opusStream, decoder, stopped: false };

  const onData = (chunk) => {
    if (monitor.stopped || !engine) return;
    engine.feedAudio(slot, downsample48kStereoTo16kMono(bufferToInt16(chunk)));
  };
  monitor.onData = onData;

  // Receive/decode errors are per-user and self-healing (the next sync re-subscribes);
  // an unhandled 'error' on either stream would take the process down.
  opusStream.on('error', (err) => console.error(`[VoiceAssistant] receive stream error for ${userId}:`, err.message));
  decoder.on('error', (err) => console.error(`[VoiceAssistant] opus decode error for ${userId}:`, err.message));
  decoder.on('data', onData);
  opusStream.pipe(decoder);

  state.monitors.set(userId, monitor);
}

async function stopMonitoring(guildId, userId, { keepSlot = false } = {}) {
  const state = guildStates.get(guildId);
  const monitor = state?.monitors.get(userId);
  if (!monitor) return;

  // Synchronous first, so no already-queued chunk can still be fed to a slot
  // that may already belong to someone else.
  monitor.stopped = true;
  state.monitors.delete(userId);
  monitor.decoder.off('data', monitor.onData);

  try { monitor.opusStream.unpipe(monitor.decoder); } catch { /* already torn down */ }
  await destroyStream(monitor.opusStream);
  try { monitor.decoder.destroy(); } catch { /* already torn down */ }

  if (!keepSlot) releaseSlotAt(monitor.slot);
}

async function stopAllMonitors(state) {
  for (const userId of [...state.monitors.keys()]) {
    await stopMonitoring(state.guildId, userId);
  }
}

// Rejoin the current channel with a different selfDeaf flag. joinVoiceChannel()
// reuses the existing connection object and rejoins it (same approach /record
// uses to hear anything), so the music player's subscription survives - but the
// receiver's streams do not, which is why the Ready handler re-subscribes.
function rejoinWithDeaf(state, selfDeaf) {
  const connection = state.connection;
  const channelId = connection?.joinConfig.channelId;
  const guild = client?.guilds.cache.get(state.guildId);
  if (!connection || !channelId || !guild) return false;

  console.log(`[VoiceAssistant] Rejoining ${state.guildId} with selfDeaf=${selfDeaf}`);
  joinVoiceChannel({
    channelId,
    guildId: state.guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf,
    selfMute: connection.joinConfig.selfMute,
  });
  return true;
}

async function doSync(state) {
  if (!started || !client) return;

  const connection = getVoiceConnection(state.guildId) ?? null;
  if (connection !== state.connection) bindConnection(state, connection);

  if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
    await stopAllMonitors(state);
    return;
  }

  const channelId = connection.joinConfig.channelId;
  const channel = channelId ? client.channels.cache.get(channelId) : null;
  if (!channel || !channel.members) {
    await stopAllMonitors(state);
    return;
  }

  // The only place the set of people we listen to is decided.
  const consenting = new Set(
    [...channel.members.values()]
      .filter((member) => !member.user.bot && isOptedIn(member.id))
      .map((member) => member.id)
  );

  for (const userId of [...state.monitors.keys()]) {
    if (!consenting.has(userId)) await stopMonitoring(state.guildId, userId);
  }

  // Deafen state first: a rejoin resets the receiver, so subscribing before it
  // would just throw the fresh streams away.
  const wantsUndeafened = consenting.size > 0;
  if (wantsUndeafened && connection.joinConfig.selfDeaf) {
    await stopAllMonitors(state);
    if (rejoinWithDeaf(state, false)) return; // the Ready transition re-syncs
  } else if (!wantsUndeafened && !connection.joinConfig.selfDeaf) {
    // Don't deafen out from under a /record session or a reply that is still
    // being spoken - both need the connection left as it is.
    if (state.active.size === 0 && state.capturing.size === 0 && !isRecording(state.guildId)) {
      await stopAllMonitors(state);
      if (rejoinWithDeaf(state, true)) return;
    }
  }

  if (connection.state.status !== VoiceConnectionStatus.Ready) return;

  for (const userId of consenting) {
    startMonitoring(state, userId);
  }
}

/**
 * Reconcile this guild's subscriptions with who is opted in and present.
 * Safe to call from anywhere; never rejects.
 * @param {string} guildId
 * @returns {Promise<void>}
 */
export function syncSubscriptions(guildId) {
  if (!started || !guildId) return Promise.resolve();
  const state = getGuildState(guildId);
  return enqueue(state, () => doSync(state));
}

function bindConnection(state, connection) {
  if (state.connection === connection) return;

  if (state.connection && state.stateHandler) {
    state.connection.off('stateChange', state.stateHandler);
  }
  state.connection = connection;
  state.stateHandler = null;
  if (!connection) return;

  const handler = (oldState, newState) => {
    if (newState.status === VoiceConnectionStatus.Ready && oldState.status !== VoiceConnectionStatus.Ready) {
      // Reconnect or rejoin: every receive stream that existed before it is
      // dead, so tear them all down and rebuild rather than topping up.
      enqueue(state, async () => {
        await stopAllMonitors(state);
        await doSync(state);
      });
    } else if (
      newState.status === VoiceConnectionStatus.Destroyed ||
      newState.status === VoiceConnectionStatus.Disconnected
    ) {
      enqueue(state, () => stopAllMonitors(state));
    }
  };

  connection.on('stateChange', handler);
  state.stateHandler = handler;
}

// ---------------------------------------------------------------------------
// Wake pipeline
// ---------------------------------------------------------------------------

function withinRateLimit(state) {
  const now = Date.now();
  state.wakeTimes = state.wakeTimes.filter((t) => now - t < WAKE_WINDOW_MS);
  if (state.wakeTimes.length >= WAKE_LIMIT) return false;
  state.wakeTimes.push(now);
  return true;
}

// The music queue disconnects 60s after the queue empties; without pushing that
// back, it can hang up on Jerry mid-sentence.
async function deferAutoLeave(guildId) {
  try {
    const { deferAutoLeave: defer } = await import('./musicQueue.js');
    defer(guildId, AUTO_LEAVE_DEFER_MS);
  } catch (err) {
    console.error('[VoiceAssistant] could not defer the music auto-leave:', err.message);
  }
}

async function handleWake({ slot, score }) {
  const owner = slotOwners[slot];
  if (!owner) return; // detection for a slot released while it was in flight
  const { guildId, userId } = owner;

  const state = guildStates.get(guildId);
  if (!started || !state) return;
  if (!isOptedIn(userId)) return; // opted out between speaking and detection
  if (state.active.has(userId)) return; // already handling this user
  if (state.active.size >= MAX_CONCURRENT_PER_GUILD) {
    console.warn(`[VoiceAssistant] Guild ${guildId} already has ${state.active.size} interactions running, ignoring wake`);
    return;
  }

  // Connection check before the rate limit: a wake we can't act on at all must
  // not burn one of the guild's 10 allowed interactions.
  const connection = getVoiceConnection(guildId);
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) return;

  if (!withinRateLimit(state)) {
    console.warn(`[VoiceAssistant] Wake rate limit hit in guild ${guildId} (${WAKE_LIMIT}/min), ignoring wake`);
    return;
  }

  console.log(`[VoiceAssistant] Wake from ${userId} in ${guildId} (score ${score.toFixed(2)})`);
  state.active.add(userId);
  await deferAutoLeave(guildId);

  try {
    await runInteraction(state, userId);
  } finally {
    state.active.delete(userId);
    await deferAutoLeave(guildId); // restart the 60s clock now that Jerry is done talking
    syncSubscriptions(guildId);
  }
}

async function runInteraction(state, userId) {
  const { guildId } = state;
  const member = state.connection?.joinConfig.channelId
    ? client.channels.cache.get(state.connection.joinConfig.channelId)?.members?.get(userId)
    : null;
  const displayName = member?.displayName ?? `Gebruiker ${userId}`;

  let stage = 'beep';
  let transcript = null;

  try {
    await playBeep(guildId);

    stage = 'capture';
    const pcm = await captureUtterance(state, userId);

    // Consent re-check: someone who ran /heyjerry off while speaking must not
    // have that audio leave the process.
    if (!isOptedIn(userId)) {
      console.log(`[VoiceAssistant] ${userId} opted out mid-capture, discarding ${pcm.length} bytes`);
      return;
    }
    if (pcm.length < MIN_CAPTURE_BYTES) {
      throw new Error(`captured only ${pcm.length} bytes of audio`);
    }

    stage = 'transcribe';
    transcript = await transcribe(pcm, { sampleRate: OUT_SAMPLE_RATE, language: 'nl' });
    console.log(`[VoiceAssistant] ${displayName}: "${transcript}"`);

    stage = 'intent';
    const intent = await parseIntent(transcript); // never rejects; runs its own fast path

    stage = 'dispatch';
    const result = await dispatch(state, { userId, displayName, intent });

    stage = 'speak';
    if (result.reply) await speak(guildId, result.reply); // null = dispatch already spoke

    await logInteraction({ displayName, transcript, summary: result.summary, detail: result.detail, ok: !result.failed });
  } catch (err) {
    const detailedStage = stage === 'transcribe' && err.stage ? `transcribe:${err.stage}` : stage;
    console.error(`[VoiceAssistant] interaction failed at ${detailedStage}:`, err.message);
    try {
      await speak(guildId, ERROR_REPLY);
    } catch (speakErr) {
      console.error('[VoiceAssistant] could not speak the error reply:', speakErr.message);
    }
    await logInteraction({ displayName, transcript, summary: `mislukt (${detailedStage})`, ok: false, stage: detailedStage, detail: err.message });
  }
}

// Records one utterance from a user who just woke the bot. The wake-word
// monitor for them is torn down first: the receiver returns the existing
// subscription per user, so the capture has to own it outright. The caller's
// syncSubscriptions() puts the monitor back.
async function captureUtterance(state, userId) {
  state.capturing.add(userId);
  try {
    await stopMonitoring(state.guildId, userId);

    const connection = getVoiceConnection(state.guildId);
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error('voice connection went away before capture started');
    }
    // Same rule as startMonitoring: never open a stream without a live consent check.
    if (!isOptedIn(userId)) throw new Error('user is not opted in');

    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: CAPTURE_SILENCE_MS },
    });
    const decoder = createDecoder();
    opusStream.on('error', (err) => console.error('[VoiceAssistant] capture stream error:', err.message));
    decoder.on('error', (err) => console.error('[VoiceAssistant] capture decode error:', err.message));

    const chunks = [];
    let bytes = 0;

    try {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(capTimer);
          resolve();
        };
        // A stream that never receives a packet never times out on its own
        // (the AfterSilence timer only starts once audio arrives).
        const capTimer = setTimeout(finish, CAPTURE_MAX_MS);

        decoder.on('data', (chunk) => {
          chunks.push(chunk);
          bytes += chunk.length;
          if (bytes >= CAPTURE_MAX_BYTES) finish();
        });
        decoder.on('end', finish);
        decoder.on('error', finish);
        opusStream.on('error', finish);
        opusStream.on('close', finish);

        opusStream.pipe(decoder);
      });
    } finally {
      try { opusStream.unpipe(decoder); } catch { /* already torn down */ }
      await destroyStream(opusStream);
      try { decoder.destroy(); } catch { /* already torn down */ }
    }

    return int16ToBuffer(downsample48kStereoTo16kMono(bufferToInt16(Buffer.concat(chunks))));
  } finally {
    state.capturing.delete(userId);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function searchSong(query, userId, displayName) {
  const { ytDlpExec, ytCookieOpts } = await import('./musicQueue.js');
  const result = await ytDlpExec(`ytsearch1:${sanitizeSearchQuery(query)}`, {
    ...ytCookieOpts,
    dumpSingleJson: true,
    noCheckCertificates: true,
    noWarnings: true,
    skipDownload: true,
  });

  const video = result.entries ? result.entries[0] : result;
  if (!video) return null;

  return {
    title: video.title || 'Unknown Title',
    url: video.webpage_url || video.url || `https://www.youtube.com/watch?v=${video.id}`,
    duration: video.duration || 0,
    thumbnail: video.thumbnail || null,
    requestedBy: displayName,
    requestedById: userId,
    source: 'youtube',
  };
}

function runCommand(command, guildId) {
  if (!runMusicCommand) throw new Error('no music command handler was wired up');
  runMusicCommand(command, guildId);
}

/**
 * Carries out an intent. Returns what Jerry should say plus a one-line summary
 * for the activity-log embed. Throws on genuine failures (the caller speaks the
 * generic error); "I understood you but there was nothing to do" comes back as
 * a normal spoken reply.
 */
async function dispatch(state, { userId, displayName, intent }) {
  const { guildId } = state;

  switch (intent.action) {
    case 'play': {
      if (!addSongToQueue) throw new Error('no add-song handler was wired up');
      const song = await searchSong(intent.query, userId, displayName);
      if (!song) {
        return { reply: `Ik kon ${intent.query} niet vinden`, summary: `play "${intent.query}" — niets gevonden`, failed: true };
      }
      const result = await addSongToQueue(song, guildId);
      if (result && result.success === false) {
        return { reply: 'Sorry, dat lukte niet', summary: `play "${song.title}" — ${result.error}`, failed: true };
      }
      return { reply: `Oké, ik speel ${song.title}`, summary: `speelt **${song.title}**` };
    }

    case 'stop':
      // 'stop' disconnects the bot, so the confirmation has to be spoken while
      // there is still a voice connection to speak it on. reply:null then tells
      // the caller the speaking is already done.
      await speak(guildId, 'Oké');
      runCommand('stop', guildId);
      return { reply: null, summary: 'stop' };

    case 'skip':
    case 'pause':
    case 'resume':
      runCommand(intent.action, guildId);
      return { reply: 'Oké', summary: intent.action };

    case 'volume':
      runCommand(`volume:${intent.volume}`, guildId);
      return { reply: 'Oké', summary: `volume ${intent.volume}%` };

    case 'nowplaying': {
      const { getQueue } = await import('./musicQueue.js');
      const song = getQueue(guildId)?.currentSong;
      return song
        ? { reply: `Er speelt nu ${song.title}`, summary: `nowplaying: ${song.title}` }
        : { reply: 'Er speelt nu niets', summary: 'nowplaying: niets' };
    }

    case 'queue': {
      const { getQueue } = await import('./musicQueue.js');
      const queue = getQueue(guildId);
      const upcoming = queue?.songs ?? [];
      if (upcoming.length === 0) {
        return { reply: 'De wachtrij is leeg', summary: 'queue: leeg' };
      }
      const plural = upcoming.length === 1 ? 'nummer' : 'nummers';
      return {
        reply: `Er ${upcoming.length === 1 ? 'staat' : 'staan'} ${upcoming.length} ${plural} in de wachtrij, het volgende is ${upcoming[0].title}`,
        summary: `queue: ${upcoming.length} ${plural}`,
      };
    }

    case 'remind': {
      addReminder({
        userId,
        channelId: GENERAL_CHANNEL_ID,
        guildId,
        message: intent.message,
        fireAt: Date.now() + intent.minutes * 60_000,
      });
      return {
        reply: `Ik herinner je over ${intent.minutes} minuten`,
        summary: `herinnering over ${intent.minutes} min: ${intent.message}`,
      };
    }

    case 'ask': {
      const { model } = getChatConfig();
      const { content } = await chatWithAI(intent.question, process.env.OPENROUTER_API_KEY, model);
      const answer = content?.trim();
      if (!answer) throw new Error('the AI returned an empty answer');
      return {
        reply: truncateForSpeech(answer),
        summary: `vraag: ${intent.question}`,
        detail: answer,
      };
    }

    default:
      return {
        reply: ERROR_REPLY,
        summary: intent.error ? `niet begrepen (${intent.error})` : 'niet begrepen',
        failed: true,
      };
  }
}

// Piper reads markdown out loud character by character, and a spoken answer
// that runs for minutes is worse than no answer - the full text goes in the
// embed instead.
function truncateForSpeech(text) {
  const spoken = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  if (spoken.length <= SPOKEN_ANSWER_MAX_CHARS) return spoken;
  const cut = spoken.slice(0, SPOKEN_ANSWER_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > SPOKEN_ANSWER_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
}

async function logInteraction({ displayName, transcript, summary, detail, ok, stage }) {
  try {
    const logChannelId = getLogChannelId();
    if (!client || !logChannelId) return;
    const channel = await client.channels.fetch(logChannelId);
    if (!channel) return;

    const spoken = transcript ? `"${transcript}"` : '_(niets verstaan)_';
    const embed = new EmbedBuilder()
      .setDescription(`🎤 **${displayName}**: ${spoken} → ${summary}`)
      .setColor(ok ? 0x57f287 : 0xed4245)
      .setTimestamp();

    if (stage) embed.addFields({ name: 'Mislukt bij', value: stage, inline: true });
    if (detail) embed.addFields({ name: ok ? 'Antwoord' : 'Details', value: String(detail).slice(0, 1024) });

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[VoiceAssistant] could not log the interaction:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function disabledReason() {
  if (!process.env.GROQ_API_KEY) return 'GROQ_API_KEY is not set';
  if (!WakewordEngine.isAvailable()) return 'wake-word model or python venv missing (run scripts/setup-voice.sh)';
  if (!isTtsAvailable()) return 'Piper TTS is not installed (run scripts/setup-voice.sh)';
  return null;
}

// The engine resolves modelPath from its options / WAKEWORD_MODEL_PATH / its own
// default, so asking it reports the model actually loaded rather than re-deriving it.
function wakeWordName() {
  if (!engine?.modelPath) return 'unknown';
  return path.basename(engine.modelPath).replace(/\.onnx$/i, '').replace(/_v\d+(?:\.\d+)*$/i, '');
}

function reconcileAll() {
  if (!client) return;
  for (const guild of client.guilds.cache.values()) {
    if (getVoiceConnection(guild.id) || guildStates.has(guild.id)) syncSubscriptions(guild.id);
  }
}

/** @returns {boolean} whether the assistant is running (env + models present). */
export function isVoiceAssistantEnabled() {
  return started;
}

/**
 * Start the voice assistant. Logs a skip line and returns when the feature
 * can't run (no Groq key, no wake-word model, no Piper).
 * @param {import('discord.js').Client} discordClient
 * @param {{runMusicCommand?: Function, addSong?: Function}} handlers - the same
 *   handlers index.js gives the web dashboard, so voice and dashboard commands
 *   go through exactly one code path.
 */
export function initVoiceAssistant(discordClient, handlers = {}) {
  if (started) return;

  const reason = disabledReason();
  if (reason) {
    console.log(`[VoiceAssistant] Disabled: ${reason}`);
    return;
  }

  client = discordClient;
  runMusicCommand = handlers.runMusicCommand ?? null;
  addSongToQueue = handlers.addSong ?? null;
  loadStore();

  engine = new WakewordEngine();
  engine.on('wake', (event) => {
    handleWake(event).catch((err) => console.error('[VoiceAssistant] wake handling failed:', err.message));
  });
  engine.start();

  voiceStateHandler = (oldState, newState) => {
    const guildId = newState?.guild?.id ?? oldState?.guild?.id;
    if (guildId) syncSubscriptions(guildId);
  };
  client.on(Events.VoiceStateUpdate, voiceStateHandler);

  // Safety net for connections that appear without a voice state update we act
  // on (e.g. the bot was already connected when this started).
  reconcileTimer = setInterval(reconcileAll, RECONCILE_INTERVAL_MS);

  started = true;
  console.log(`[VoiceAssistant] Initialized (wake word: ${wakeWordName()})`);
  reconcileAll();
}

/**
 * Tear everything down. Synchronous on purpose: index.js calls this from
 * flushState(), which also runs on uncaughtException and must not await.
 */
export function stopVoiceAssistant() {
  if (!started) return;
  started = false;

  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  if (client && voiceStateHandler) {
    client.off(Events.VoiceStateUpdate, voiceStateHandler);
    voiceStateHandler = null;
  }

  for (const state of guildStates.values()) {
    if (state.connection && state.stateHandler) {
      state.connection.off('stateChange', state.stateHandler);
    }
    for (const monitor of state.monitors.values()) {
      monitor.stopped = true;
      try { monitor.opusStream.destroy(); } catch { /* already gone */ }
      try { monitor.decoder.destroy(); } catch { /* already gone */ }
    }
    state.monitors.clear();
  }
  guildStates.clear();
  slotOwners.fill(null);

  if (engine) {
    engine.stop(); // sync child.kill(), no await needed
    engine = null;
  }

  try {
    saveStore(); // opt-ins already persist on every change; this is belt and braces
  } catch (err) {
    console.error('[VoiceAssistant] could not flush the opt-in store:', err.message);
  }

  console.log('[VoiceAssistant] Stopped');
}
