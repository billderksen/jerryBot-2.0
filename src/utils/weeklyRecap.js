import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EmbedBuilder } from 'discord.js';
import { getDiscordActivity } from './discordTracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');

const RECAPS_FILE = join(DATA_DIR, 'weeklyRecaps.json');
const SNAPSHOTS_FILE = join(DATA_DIR, 'weeklyRecapSnapshots.json');
const RECENTLY_PLAYED_FILE = join(DATA_DIR, 'recentlyPlayed.json');
const PESTEN_LEADERBOARD = join(DATA_DIR, 'pestenLeaderboard.json');
const HITSTER_LEADERBOARD = join(DATA_DIR, 'hitsterLeaderboard.json');
const PICTIONARY_LEADERBOARD = join(DATA_DIR, 'pictionaryLeaderboard.json');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let recapData = { channelId: null, scheduleDay: 0, scheduleHour: 0, recaps: [] };
let snapshots = {};
let discordClient = null;
let scheduleTimeout = null;

function loadJSON(path) {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
  } catch (e) {
    console.error(`[WeeklyRecap] Error loading ${path}:`, e.message);
  }
  return null;
}

function saveRecaps() {
  try {
    writeFileSync(RECAPS_FILE, JSON.stringify(recapData, null, 2));
  } catch (e) {
    console.error('[WeeklyRecap] Error saving recaps:', e.message);
  }
}

function saveSnapshots() {
  try {
    writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snapshots, null, 2));
  } catch (e) {
    console.error('[WeeklyRecap] Error saving snapshots:', e.message);
  }
}

function getWeekBounds(now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  // Walk back to most recent scheduled day/hour
  while (end.getDay() !== recapData.scheduleDay || end > now) {
    end.setDate(end.getDate() - 1);
  }
  end.setHours(recapData.scheduleHour, 0, 0, 0);

  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  return { start, end };
}

function getCurrentWeekBounds() {
  // For "current week so far": from last scheduled time to now
  const now = new Date();
  const { end: lastRecapTime } = getWeekBounds(now);
  return { start: lastRecapTime, end: now };
}

function collectMusicStats(startMs, endMs) {
  const recentlyPlayed = loadJSON(RECENTLY_PLAYED_FILE) || [];

  const weekSongs = recentlyPlayed.filter(s => s.playedAt >= startMs && s.playedAt < endMs);

  if (weekSongs.length === 0) {
    return {
      totalSongsPlayed: 0,
      totalDuration: 0,
      uniqueSongs: 0,
      topSongs: [],
      topDJs: [],
      mostActiveDJ: null,
      mostPlayedSong: null
    };
  }

  // Count songs by URL
  const songCounts = {};
  for (const s of weekSongs) {
    const key = s.url;
    if (!songCounts[key]) {
      songCounts[key] = { title: s.title, url: s.url, thumbnail: s.thumbnail, count: 0, duration: s.duration || 0 };
    }
    songCounts[key].count++;
  }

  const topSongs = Object.values(songCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Count by requester
  const djCounts = {};
  for (const s of weekSongs) {
    const name = s.requestedBy || 'Unknown';
    if (name === '📻 Radio') continue; // Exclude radio from DJ rankings
    if (!djCounts[name]) {
      djCounts[name] = { name, id: s.requestedById, count: 0 };
    }
    djCounts[name].count++;
  }

  const topDJs = Object.values(djCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const totalDuration = weekSongs.reduce((sum, s) => sum + (s.duration || 0), 0);

  return {
    totalSongsPlayed: weekSongs.length,
    totalDuration,
    uniqueSongs: Object.keys(songCounts).length,
    topSongs,
    topDJs,
    mostActiveDJ: topDJs[0] || null,
    mostPlayedSong: topSongs[0] || null
  };
}

function collectGameStats() {
  const games = {};
  let totalGamesPlayed = 0;

  const leaderboards = [
    { name: 'pesten', file: PESTEN_LEADERBOARD },
    { name: 'hitster', file: HITSTER_LEADERBOARD },
    { name: 'pictionary', file: PICTIONARY_LEADERBOARD }
  ];

  for (const lb of leaderboards) {
    const current = loadJSON(lb.file);
    const prev = snapshots[lb.name] || { players: {} };
    const players = [];

    if (current?.players) {
      for (const [id, data] of Object.entries(current.players)) {
        const prevData = prev.players?.[id] || { gamesPlayed: 0, gamesWon: 0 };
        const deltaPlayed = (data.gamesPlayed || 0) - (prevData.gamesPlayed || 0);
        const deltaWon = (data.gamesWon || 0) - (prevData.gamesWon || 0);

        if (deltaPlayed > 0) {
          players.push({
            id,
            displayName: data.displayName || 'Unknown',
            gamesPlayed: deltaPlayed,
            gamesWon: deltaWon
          });
        }
      }
    }

    players.sort((a, b) => b.gamesPlayed - a.gamesPlayed);
    const weekTotal = players.reduce((sum, p) => sum + p.gamesPlayed, 0);
    // Each game is counted per-player, so approximate unique games
    const uniqueGames = players.length > 0 ? Math.max(1, Math.ceil(weekTotal / Math.max(players.length, 1))) : 0;
    totalGamesPlayed += uniqueGames;

    games[lb.name] = { players, totalPlayed: uniqueGames };
  }

  return { ...games, totalGamesPlayed };
}

function collectActivityStats(startMs, endMs) {
  const recentlyPlayed = loadJSON(RECENTLY_PLAYED_FILE) || [];
  const weekSongs = recentlyPlayed.filter(s => s.playedAt >= startMs && s.playedAt < endMs);

  const dayCounts = DAY_NAMES.map(day => ({ day, count: 0 }));
  const hourCounts = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));

  for (const s of weekSongs) {
    const d = new Date(s.playedAt);
    dayCounts[d.getDay()].count++;
    hourCounts[d.getHours()].count++;
  }

  const mostActiveDay = dayCounts.reduce((max, d) => d.count > max.count ? d : max, dayCounts[0]);
  const peakHour = hourCounts.reduce((max, h) => h.count > max.count ? h : max, hourCounts[0]);

  return {
    mostActiveDay: mostActiveDay.day,
    peakHour: peakHour.hour,
    dayCounts,
    hourCounts
  };
}

function generateFunStats(music, activity, startMs, endMs, discord) {
  const facts = [];
  const recentlyPlayed = loadJSON(RECENTLY_PLAYED_FILE) || [];
  const weekSongs = recentlyPlayed.filter(s => s.playedAt >= startMs && s.playedAt < endMs);

  // Most repeated song
  if (music.mostPlayedSong && music.mostPlayedSong.count > 1) {
    facts.push(`"${music.mostPlayedSong.title}" was played ${music.mostPlayedSong.count} times this week`);
  }

  // Late night listening (midnight to 5am)
  const lateNight = weekSongs.filter(s => {
    const h = new Date(s.playedAt).getHours();
    return h >= 0 && h < 5;
  }).length;
  if (lateNight > 0) {
    facts.push(`${lateNight} song${lateNight !== 1 ? 's' : ''} played between midnight and 5 AM`);
  }

  // Radio vs human ratio
  const radioSongs = weekSongs.filter(s => s.requestedBy === '📻 Radio').length;
  const humanSongs = weekSongs.length - radioSongs;
  if (radioSongs > 0 && humanSongs > 0) {
    facts.push(`Radio played ${radioSongs} song${radioSongs !== 1 ? 's' : ''}, humans played ${humanSongs}`);
  } else if (radioSongs > 0) {
    facts.push(`Radio was the only DJ this week with ${radioSongs} songs`);
  }

  // Peak hour fun fact
  if (activity.peakHour !== undefined) {
    const h = activity.peakHour;
    const label = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
    facts.push(`Peak listening hour: ${label}`);
  }

  // Total listening time
  if (music.totalDuration > 3600) {
    const hours = Math.floor(music.totalDuration / 3600);
    facts.push(`${hours}+ hour${hours !== 1 ? 's' : ''} of music played`);
  }

  // Discord chat stats
  if (discord && discord.topChatters.length > 0) {
    const top = discord.topChatters[0];
    facts.push(`${top.name} sent ${top.count} messages this week`);
  }

  // Discord voice stats
  if (discord && discord.topVoice.length > 0) {
    const top = discord.topVoice[0];
    const hours = Math.floor(top.minutes / 60);
    const mins = top.minutes % 60;
    const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    facts.push(`${top.name} spent ${timeStr} in voice channels`);
  }

  return facts;
}

function collectDiscordStats(startMs, endMs) {
  const { messages, voice } = getDiscordActivity(startMs, endMs);
  const totalMessages = messages.reduce((sum, m) => sum + m.count, 0);
  const totalVoiceMinutes = voice.reduce((sum, v) => sum + v.minutes, 0);

  return {
    topChatters: messages.slice(0, 5),
    topVoice: voice.slice(0, 5),
    totalMessages,
    totalVoiceMinutes
  };
}

function buildRecap(startMs, endMs) {
  const music = collectMusicStats(startMs, endMs);
  const games = collectGameStats();
  const activity = collectActivityStats(startMs, endMs);
  const discord = collectDiscordStats(startMs, endMs);
  const funStats = generateFunStats(music, activity, startMs, endMs, discord);

  const isEmpty = music.totalSongsPlayed === 0 && games.totalGamesPlayed === 0 && discord.totalMessages === 0 && discord.totalVoiceMinutes === 0;

  return {
    id: `recap_${endMs}`,
    weekStart: startMs,
    weekEnd: endMs,
    generatedAt: Date.now(),
    music,
    games,
    activity,
    discord,
    funStats,
    isEmpty
  };
}

function snapshotLeaderboards() {
  const leaderboards = [
    { name: 'pesten', file: PESTEN_LEADERBOARD },
    { name: 'hitster', file: HITSTER_LEADERBOARD },
    { name: 'pictionary', file: PICTIONARY_LEADERBOARD }
  ];

  for (const lb of leaderboards) {
    const data = loadJSON(lb.file);
    snapshots[lb.name] = data || { players: {} };
  }
  saveSnapshots();
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function buildDiscordEmbed(recap) {
  if (recap.isEmpty) {
    return new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('📊 Weekly Recap')
      .setDescription('Quiet week — no activity. See you next time!')
      .setTimestamp(new Date(recap.generatedAt));
  }

  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle('📊 Weekly Recap')
    .setDescription(`Week of ${new Date(recap.weekStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} — ${new Date(recap.weekEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`)
    .setTimestamp(new Date(recap.generatedAt));

  // Music
  if (recap.music.totalSongsPlayed > 0) {
    embed.addFields({
      name: '🎵 Music',
      value: `**${recap.music.totalSongsPlayed}** songs played · **${formatDuration(recap.music.totalDuration)}** total · **${recap.music.uniqueSongs}** unique tracks`,
      inline: false
    });

    // Top Songs
    if (recap.music.topSongs.length > 0) {
      const songList = recap.music.topSongs
        .map((s, i) => `${i + 1}. ${s.title} (×${s.count})`)
        .join('\n');
      embed.addFields({ name: '🏆 Top Songs', value: songList, inline: true });
    }

    // Top DJ
    if (recap.music.topDJs.length > 0) {
      const dj = recap.music.topDJs[0];
      embed.addFields({ name: '🎧 Top DJ', value: `**${dj.name}** with ${dj.count} songs`, inline: true });
    }
  }

  // Discord Activity
  if (recap.discord) {
    const dc = recap.discord;
    if (dc.topChatters.length > 0) {
      const top = dc.topChatters[0];
      embed.addFields({
        name: '\uD83D\uDCAC Chat',
        value: `**${top.name}** sent ${top.count} messages\n${dc.totalMessages} total messages`,
        inline: true
      });
    }
    if (dc.topVoice.length > 0) {
      const top = dc.topVoice[0];
      const topHours = Math.floor(top.minutes / 60);
      const topMins = top.minutes % 60;
      const topStr = topHours > 0 ? `${topHours}h ${topMins}m` : `${topMins}m`;
      const totalHours = Math.floor(dc.totalVoiceMinutes / 60);
      const totalMins = dc.totalVoiceMinutes % 60;
      const totalStr = totalHours > 0 ? `${totalHours}h ${totalMins}m` : `${totalMins}m`;
      embed.addFields({
        name: '\uD83C\uDF99\uFE0F Voice',
        value: `**${top.name}** for ${topStr}\n${totalStr} total voice time`,
        inline: true
      });
    }
  }

  // Games
  const gameLines = [];
  for (const game of ['pesten', 'hitster', 'pictionary']) {
    const g = recap.games[game];
    if (g && g.players.length > 0) {
      const top = g.players[0];
      gameLines.push(`**${game.charAt(0).toUpperCase() + game.slice(1)}** — ${g.players.length} player${g.players.length !== 1 ? 's' : ''}, top: ${top.displayName} (${top.gamesWon}W/${top.gamesPlayed}P)`);
    }
  }
  if (gameLines.length > 0) {
    embed.addFields({ name: '🎮 Games', value: gameLines.join('\n'), inline: false });
  }

  // Activity
  if (recap.activity.mostActiveDay) {
    embed.addFields({
      name: '📅 Activity',
      value: `Most active day: **${recap.activity.mostActiveDay}** · Peak hour: **${recap.activity.peakHour}:00**`,
      inline: false
    });
  }

  // Fun Facts
  if (recap.funStats.length > 0) {
    const facts = recap.funStats.map(f => `• ${f}`).join('\n');
    embed.addFields({ name: '✨ Fun Facts', value: facts, inline: false });
  }

  return embed;
}

async function postRecapToChannel(recap) {
  if (!discordClient || !recapData.channelId) return;

  try {
    const channel = await discordClient.channels.fetch(recapData.channelId);
    if (channel) {
      const embed = buildDiscordEmbed(recap);
      await channel.send({ embeds: [embed] });
      console.log('[WeeklyRecap] Posted recap to channel', recapData.channelId);
    }
  } catch (e) {
    console.error('[WeeklyRecap] Error posting recap:', e.message);
  }
}

async function fireRecap() {
  console.log('[WeeklyRecap] Generating scheduled recap...');
  const now = new Date();
  const end = new Date(now);
  end.setHours(recapData.scheduleHour, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  const recap = buildRecap(start.getTime(), end.getTime());

  // Store the recap
  recapData.recaps.push(recap);
  saveRecaps();

  // Snapshot leaderboards for next week's delta
  snapshotLeaderboards();

  // Post to Discord
  await postRecapToChannel(recap);

  // Schedule next
  scheduleNext();
}

function msUntilNext() {
  const now = new Date();
  const next = new Date(now);

  // Set to scheduled hour
  next.setHours(recapData.scheduleHour, 0, 0, 0);

  // Set to the scheduled day of week
  const currentDay = next.getDay();
  let daysUntil = recapData.scheduleDay - currentDay;
  if (daysUntil < 0) daysUntil += 7;
  if (daysUntil === 0 && next <= now) daysUntil = 7;
  next.setDate(next.getDate() + daysUntil);

  return next.getTime() - now.getTime();
}

function scheduleNext() {
  if (scheduleTimeout) {
    clearTimeout(scheduleTimeout);
    scheduleTimeout = null;
  }

  const ms = msUntilNext();
  const hours = Math.round(ms / 3600000);
  console.log(`[WeeklyRecap] Next recap in ~${hours} hours (${DAY_NAMES[recapData.scheduleDay]} ${recapData.scheduleHour}:00)`);

  scheduleTimeout = setTimeout(fireRecap, ms);
}

// === Public API ===

export function initWeeklyRecap(client) {
  discordClient = client;

  // Load stored data
  const stored = loadJSON(RECAPS_FILE);
  if (stored) {
    recapData = { channelId: null, scheduleDay: 0, scheduleHour: 0, recaps: [], ...stored };
  }

  const storedSnapshots = loadJSON(SNAPSHOTS_FILE);
  if (storedSnapshots) {
    snapshots = storedSnapshots;
  } else {
    // First run: snapshot current state
    snapshotLeaderboards();
  }

  scheduleNext();
  console.log('[WeeklyRecap] Initialized');
}

export function stopWeeklyRecap() {
  if (scheduleTimeout) {
    clearTimeout(scheduleTimeout);
    scheduleTimeout = null;
  }
}

export function generateCurrentRecap() {
  const { start, end } = getCurrentWeekBounds();
  return buildRecap(start.getTime(), end.getTime());
}

export function getLatestRecap() {
  if (recapData.recaps.length === 0) return null;
  return recapData.recaps[recapData.recaps.length - 1];
}

export function getRecaps() {
  return recapData.recaps.map(r => ({
    id: r.id,
    weekStart: r.weekStart,
    weekEnd: r.weekEnd,
    generatedAt: r.generatedAt,
    isEmpty: r.isEmpty
  }));
}

export function getRecap(id) {
  return recapData.recaps.find(r => r.id === id) || null;
}

export function setRecapChannel(channelId) {
  recapData.channelId = channelId;
  saveRecaps();
  return { success: true };
}

export function setRecapSchedule(day, hour) {
  if (day < 0 || day > 6) return { success: false, error: 'Day must be 0-6 (Sun-Sat)' };
  if (hour < 0 || hour > 23) return { success: false, error: 'Hour must be 0-23' };
  recapData.scheduleDay = day;
  recapData.scheduleHour = hour;
  saveRecaps();
  scheduleNext();
  return { success: true, day: DAY_NAMES[day], hour };
}

export function getRecapSettings() {
  return {
    channelId: recapData.channelId,
    scheduleDay: recapData.scheduleDay,
    scheduleHour: recapData.scheduleHour,
    scheduleDayName: DAY_NAMES[recapData.scheduleDay]
  };
}
