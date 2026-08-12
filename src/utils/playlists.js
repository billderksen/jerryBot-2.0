import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'playlists.json');

const MAX_PLAYLISTS = 25;
const MAX_SONGS = 500;

let data = null;

function load() {
  if (data !== null) return;
  data = loadJsonSync(DATA_FILE, {});
}

function save() {
  saveJsonSync(DATA_FILE, data);
}

function ensureUser(userId) {
  load();
  if (!data[userId]) {
    data[userId] = { playlists: {} };
  }
  return data[userId];
}

function generateId() {
  return 'm' + crypto.randomBytes(4).toString('hex');
}

export function createPlaylist(userId, name, createdBy) {
  const user = ensureUser(userId);
  const count = Object.keys(user.playlists).length;
  if (count >= MAX_PLAYLISTS) {
    return { success: false, error: `Maximum of ${MAX_PLAYLISTS} playlists reached.` };
  }
  const id = generateId();
  user.playlists[id] = {
    name,
    createdBy: createdBy || 'Unknown',
    createdAt: Date.now(),
    songs: []
  };
  save();
  return { success: true, playlistId: id };
}

export function deletePlaylist(userId, playlistId) {
  load();
  const user = data[userId];
  if (!user || !user.playlists[playlistId]) {
    return { success: false, error: 'Playlist not found.' };
  }
  delete user.playlists[playlistId];
  save();
  return { success: true };
}

export function renamePlaylist(userId, playlistId, name) {
  load();
  const user = data[userId];
  if (!user || !user.playlists[playlistId]) {
    return { success: false, error: 'Playlist not found.' };
  }
  user.playlists[playlistId].name = name;
  save();
  return { success: true };
}

export function addSong(userId, playlistId, song) {
  load();
  const user = data[userId];
  if (!user || !user.playlists[playlistId]) {
    return { success: false, error: 'Playlist not found.' };
  }
  const playlist = user.playlists[playlistId];
  if (playlist.songs.length >= MAX_SONGS) {
    return { success: false, error: `Maximum of ${MAX_SONGS} songs per playlist reached.` };
  }
  if (song.url && playlist.songs.some(s => s.url === song.url)) {
    return { success: false, error: 'Song already in this playlist.' };
  }
  playlist.songs.push({
    url: song.url,
    title: song.title,
    thumbnail: song.thumbnail || null,
    duration: song.duration || 0
  });
  save();
  return { success: true };
}

export function removeSong(userId, playlistId, songIndex) {
  load();
  const user = data[userId];
  if (!user || !user.playlists[playlistId]) {
    return { success: false, error: 'Playlist not found.' };
  }
  const playlist = user.playlists[playlistId];
  if (songIndex < 0 || songIndex >= playlist.songs.length) {
    return { success: false, error: 'Invalid song index.' };
  }
  playlist.songs.splice(songIndex, 1);
  save();
  return { success: true };
}

export function reorderSong(userId, playlistId, from, to) {
  load();
  const user = data[userId];
  if (!user || !user.playlists[playlistId]) {
    return { success: false, error: 'Playlist not found.' };
  }
  const songs = user.playlists[playlistId].songs;
  if (from < 0 || from >= songs.length || to < 0 || to >= songs.length) {
    return { success: false, error: 'Invalid index.' };
  }
  const [song] = songs.splice(from, 1);
  songs.splice(to, 0, song);
  save();
  return { success: true };
}

export function reorderPlaylist(userId, from, to) {
  load();
  const user = data[userId];
  if (!user) return { success: false, error: 'No playlists found.' };
  const entries = Object.entries(user.playlists);
  if (from < 0 || from >= entries.length || to < 0 || to >= entries.length) {
    return { success: false, error: 'Invalid index.' };
  }
  const [moved] = entries.splice(from, 1);
  entries.splice(to, 0, moved);
  user.playlists = Object.fromEntries(entries);
  save();
  return { success: true };
}

export function getPlaylists(userId) {
  load();
  const user = data[userId];
  if (!user) return [];
  return Object.entries(user.playlists).map(([id, pl]) => ({
    id,
    name: pl.name,
    songCount: pl.songs.length,
    createdBy: pl.createdBy || 'Unknown',
    createdAt: pl.createdAt
  }));
}

export function getPlaylist(userId, playlistId) {
  load();
  const user = data[userId];
  if (!user || !user.playlists[playlistId]) return null;
  const pl = user.playlists[playlistId];
  return {
    id: playlistId,
    name: pl.name,
    createdBy: pl.createdBy || 'Unknown',
    createdAt: pl.createdAt,
    songs: pl.songs
  };
}

export function getAllPlaylistNames(userId) {
  load();
  const user = data[userId];
  if (!user) return [];
  return Object.entries(user.playlists).map(([id, pl]) => ({
    name: pl.name,
    value: id
  }));
}

export function getPlaylistSongNames(userId, playlistId) {
  load();
  const user = data[userId];
  if (!user || !user.playlists[playlistId]) return [];
  return user.playlists[playlistId].songs.map((s, i) => ({
    name: s.title.length > 100 ? s.title.substring(0, 97) + '...' : s.title,
    value: String(i)
  }));
}
