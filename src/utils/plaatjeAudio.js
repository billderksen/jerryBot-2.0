// Audio voor PLAATJE: songpool, gated download → mp3-clip, en Jerry-in-VC-playback.
// De clip is de enige audio die de server ooit uitserveert: begrensd (75s),
// zonder metadata, onder een anonieme URL — de geheimhoudings-invariant hangt hierop.
import { spawn, execSync } from 'child_process';
import { existsSync, unlinkSync, readdirSync, statSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import ffmpegStatic from 'ffmpeg-static';
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, VoiceConnectionStatus,
} from '@discordjs/voice';
import { ytDlpExec, ytCookieOpts, runGatedDownload, DOWNLOAD_PRIORITY, getQueue } from './musicQueue.js';
import { isRecording } from './voiceRecorder.js';
import { startOffsetSeconds } from './plaatjeGame.js';
import { loadJsonSync } from './jsonStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SONGS_FILE = join(__dirname, '../../data/hitsterSongs.json');
const IMPORTS_FILE = join(__dirname, '../../data/plaatjeImports.json');
const CLIPS_DIR = join(__dirname, '../../data/plaatjeClips');

// Voorgesneden clip uit de permanente cache (gevuld door de editie-pijplijn).
// dir is injecteerbaar voor tests.
export function cachedClipPath(youtubeId, dir = CLIPS_DIR) {
  if (!/^[\w-]{11}$/.test(String(youtubeId))) return null;
  const p = join(dir, `${youtubeId}.mp3`);
  return existsSync(p) ? p : null;
}

// Zelfde voorkeursvolgorde als musicQueue: ffmpeg-static, maar op Linux wint het systeem-ffmpeg.
let ffmpegPath = ffmpegStatic;
if (!ffmpegPath || process.platform === 'linux') {
  try {
    const systemFfmpeg = execSync('command -v ffmpeg', { encoding: 'utf8' }).trim();
    if (systemFfmpeg) ffmpegPath = systemFfmpeg;
  } catch { /* ffmpeg-static blijft de fallback */ }
}

// Cleanup für stale plaatje_* files in /tmp
export function isStalePlaatjeFile(name, mtimeMs, nowMs) {
  return name.startsWith('plaatje_') && nowMs - mtimeMs > 60 * 60_000;
}

export function sweepStalePlaatjeFiles() {
  try {
    const tmpDir = tmpdir();
    const now = Date.now();
    for (const name of readdirSync(tmpDir)) {
      try {
        if (isStalePlaatjeFile(name, statSync(join(tmpDir, name)).mtimeMs, now)) {
          unlinkSync(join(tmpDir, name));
        }
      } catch { /* file already gone or permission issue */ }
    }
  } catch { /* tmpdir doesn't exist or permission issue */ }
}

sweepStalePlaatjeFiles();

export function listPools() {
  const base = loadJsonSync(SONGS_FILE, { songs: [] }).songs;
  const imports = loadJsonSync(IMPORTS_FILE, { pools: {} }).pools;
  return [
    { id: 'base', name: 'Basis', count: base.length },
    ...Object.entries(imports).map(([id, p]) => ({ id, name: p.name, count: p.songs.length })),
  ];
}

export function getPoolSongs(poolIds) {
  const imports = loadJsonSync(IMPORTS_FILE, { pools: {} }).pools;
  const seen = new Set();
  const out = [];
  for (const id of poolIds) {
    const songs = id === 'base'
      ? loadJsonSync(SONGS_FILE, { songs: [] }).songs
      : (imports[id]?.songs ?? []);
    for (const s of songs) {
      if (s?.youtubeId && !seen.has(s.youtubeId)) { seen.add(s.youtubeId); out.push(s); }
    }
  }
  return out;
}

// Apart exporteerbaar zodat de keuze puur getest kan worden.
export function pickSongFrom(songs, usedIds) {
  const eligible = songs.filter((s) => !usedIds.has(s.youtubeId));
  if (!eligible.length) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

export function pickSong(poolIds, usedIds) {
  return pickSongFrom(getPoolSongs(poolIds), usedIds);
}

export function buildClipArgs(inputPath, outputPath, offsetSec) {
  return ['-y', '-ss', String(offsetSec), '-t', '75', '-i', inputPath,
    '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1', '-f', 'mp3', outputPath];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

export async function prepareRoundClip(song, roomId) {
  const cached = cachedClipPath(song.youtubeId);
  if (cached) {
    // Kopieer naar een ronde-eigen tmp-pad: de bestaande removeClip-lifecycle
    // mag de cache zelf nooit opruimen.
    const mp3Path = join(tmpdir(), `plaatje_${roomId}_${Date.now()}.mp3`);
    copyFileSync(cached, mp3Path);
    return { mp3Path, offsetSec: 0 };
  }
  const url = `https://www.youtube.com/watch?v=${song.youtubeId}`;
  const meta = await ytDlpExec(url, {
    ...ytCookieOpts, dumpSingleJson: true, noCheckCertificates: true, noWarnings: true, skipDownload: true,
  });
  const offsetSec = startOffsetSeconds(Number(meta.duration));
  const base = join(tmpdir(), `plaatje_${roomId}_${Date.now()}`);
  const rawPath = `${base}.raw.opus`;
  const mp3Path = `${base}.mp3`;
  try {
    await runGatedDownload(async () => {
      await ytDlpExec.exec(url, {
        ...ytCookieOpts, output: rawPath, noCheckCertificates: true, noWarnings: true,
        format: 'bestaudio[acodec=opus]/bestaudio[acodec=aac]/bestaudio[abr>=160]/bestaudio/best',
      }, { timeout: 60_000 });
      if (!existsSync(rawPath)) throw new Error('download produced no file');
    }, { priority: DOWNLOAD_PRIORITY.CACHE, label: `plaatje:${roomId}` });
    try {
      await runFfmpeg(buildClipArgs(rawPath, mp3Path, offsetSec));
    } catch (err) {
      try { unlinkSync(mp3Path); } catch { /* partial file already gone */ }
      throw err;
    }
    return { mp3Path, offsetSec };
  } finally {
    try { unlinkSync(rawPath); } catch { /* al weg */ }
    try { unlinkSync(rawPath + '.part'); } catch { /* al weg */ }
  }
}

export function removeClip(mp3Path) {
  try { if (mp3Path) unlinkSync(mp3Path); } catch { /* al weg */ }
}

// ── Jerry in VC ─────────────────────────────────────────────────────────────
// Eén sessie per guild. We spelen alleen op een verbinding die niemand anders
// bezit: muziek (queue.connection) en /record gaan altijd voor. Een verbinding
// die wij zelf openden, ruimen wij ook zelf op — een bestaande (assistent-)
// verbinding hergebruiken we alleen om op af te spelen.
const vcSessions = new Map(); // guildId -> { player, createdConnection: boolean, roomId: string }

export async function startVcClip({ client, guildId, userId, mp3Path, roomId }) {
  if (getQueue(guildId)?.connection) return { ok: false, reason: 'De muziekspeler gebruikt het voicekanaal' };
  if (isRecording(guildId)) return { ok: false, reason: 'Er loopt een opname' };
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(userId).catch(() => null);
  const channel = member?.voice?.channel;
  if (!channel) return { ok: false, reason: 'De host zit niet in een voicekanaal' };

  // Re-check ownership after awaited fetches
  if (getQueue(guildId)?.connection) return { ok: false, reason: 'De muziekspeler gebruikt het voicekanaal' };
  if (isRecording(guildId)) return { ok: false, reason: 'Er loopt een opname' };

  let session = vcSessions.get(guildId);
  let connection = getVoiceConnection(guildId);

  // Always validate connection — reuse existing only if alive
  if (connection && connection.state.status === VoiceConnectionStatus.Destroyed) {
    connection = null;
  }

  if (!session) {
    if (!connection) {
      connection = joinVoiceChannel({
        channelId: channel.id, guildId, adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true, selfMute: false,
      });
      session = { player: createAudioPlayer(), createdConnection: true };
    } else {
      session = { player: createAudioPlayer(), createdConnection: false };
    }
    vcSessions.set(guildId, session);
  } else if (!connection) {
    // Session exists but connection died; rejoin
    connection = joinVoiceChannel({
      channelId: channel.id, guildId, adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, selfMute: false,
    });
    session.createdConnection = true;
  }

  session.roomId = roomId;

  // Always subscribe (idempotent)
  connection.subscribe(session.player);
  session.player.play(createAudioResource(mp3Path));
  return { ok: true };
}

export function stopVcClip(guildId, roomId) {
  const session = vcSessions.get(guildId);
  if (session && roomId !== undefined && session.roomId !== roomId) return;
  session?.player.stop(true);
}

export function teardownVc(guildId, roomId) {
  const session = vcSessions.get(guildId);
  if (!session) return;
  if (roomId !== undefined && session.roomId !== roomId) return;
  session.player.stop(true);
  if (session.createdConnection && !getQueue(guildId)?.connection && !isRecording(guildId)) {
    getVoiceConnection(guildId)?.destroy();
  }
  vcSessions.delete(guildId);
}
