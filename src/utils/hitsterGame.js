import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load songs database
const songsPath = path.join(__dirname, '../../data/hitsterSongs.json');
let songsData = { songs: [] };

function loadSongs() {
    try {
        if (fs.existsSync(songsPath)) {
            songsData = JSON.parse(fs.readFileSync(songsPath, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading Hitster songs:', error);
    }
}

loadSongs();

// Load/save leaderboard
const leaderboardPath = path.join(__dirname, '../../data/hitsterLeaderboard.json');
let leaderboard = { players: {} };

function loadLeaderboard() {
    try {
        if (fs.existsSync(leaderboardPath)) {
            leaderboard = JSON.parse(fs.readFileSync(leaderboardPath, 'utf8'));
        }
    } catch (error) {
        console.error('Error loading Hitster leaderboard:', error);
    }
}

function saveLeaderboard() {
    try {
        fs.writeFileSync(leaderboardPath, JSON.stringify(leaderboard, null, 2));
    } catch (error) {
        console.error('Error saving Hitster leaderboard:', error);
    }
}

loadLeaderboard();

// Debounced save
let saveTimeout = null;
function debouncedSaveLeaderboard() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveLeaderboard, 5000);
}

class HitsterRoom {
    constructor(id, name, hostId, hostName, settings = {}) {
        this.id = id;
        this.name = name;
        this.hostId = hostId;
        this.hostName = hostName;
        this.players = new Map();
        this.spectators = new Map();
        this.state = 'waiting'; // waiting, playing, ended
        this.currentPlayerIndex = 0;
        this.currentSong = null;
        this.usedSongs = new Set();
        this.turnPhase = 'listening'; // listening, placing, stealing
        this.turnTimer = null;
        this.stealQueue = [];
        this.currentStealerIndex = 0;
        this.settings = {
            cardsToWin: settings.cardsToWin || 10,
            listenTime: settings.listenTime || 30,
            placeTime: settings.placeTime || 30,
            stealTime: settings.stealTime || 15,
            maxPlayers: settings.maxPlayers || 8,
            ...settings
        };
        this.createdAt = Date.now();
        this.playerOrder = [];
    }

    addPlayer(userId, userName) {
        // Check if player already exists (reconnection)
        if (this.players.has(userId)) {
            const player = this.players.get(userId);
            player.connected = true;
            player.name = userName; // Update name in case it changed
            return { success: true, isSpectator: false, reconnected: true };
        }

        // Check if was a spectator reconnecting
        if (this.spectators.has(userId)) {
            const spectator = this.spectators.get(userId);
            spectator.connected = true;
            spectator.name = userName;
            return { success: true, isSpectator: true, reconnected: true };
        }

        if (this.state === 'playing') {
            return this.addSpectator(userId, userName);
        }

        if (this.players.size >= this.settings.maxPlayers) {
            return { success: false, error: 'Room is full' };
        }

        this.players.set(userId, {
            id: userId,
            name: userName,
            timeline: [],
            score: 0,
            connected: true
        });

        return { success: true, isSpectator: false };
    }

    // Check if a player or spectator exists in the room (for reconnection)
    hasPlayer(userId) {
        return this.players.has(userId) || this.spectators.has(userId);
    }

    addSpectator(userId, userName) {
        if (this.players.has(userId)) {
            return { success: false, error: 'Already a player' };
        }

        this.spectators.set(userId, {
            id: userId,
            name: userName,
            connected: true
        });

        return { success: true, isSpectator: true };
    }

    removePlayer(userId) {
        const wasPlayer = this.players.has(userId);
        this.players.delete(userId);
        this.spectators.delete(userId);

        this.playerOrder = this.playerOrder.filter(id => id !== userId);

        if (wasPlayer && this.state === 'playing' && this.playerOrder.length > 0) {
            if (this.currentPlayerIndex >= this.playerOrder.length) {
                this.currentPlayerIndex = 0;
            }
        }

        if (userId === this.hostId && this.players.size > 0) {
            const firstPlayer = this.players.values().next().value;
            this.hostId = firstPlayer.id;
            this.hostName = firstPlayer.name;
        }

        return this.players.size === 0 && this.spectators.size === 0;
    }

    startGame() {
        if (this.players.size < 2) {
            return { success: false, error: 'Need at least 2 players' };
        }

        this.state = 'playing';
        this.playerOrder = Array.from(this.players.keys());
        this.shuffleArray(this.playerOrder);
        this.currentPlayerIndex = 0;
        this.usedSongs.clear();

        for (const player of this.players.values()) {
            player.timeline = [];
            player.score = 0;
        }

        return { success: true };
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    getCurrentPlayer() {
        if (this.playerOrder.length === 0) return null;
        const playerId = this.playerOrder[this.currentPlayerIndex];
        return this.players.get(playerId);
    }

    drawSong() {
        const availableSongs = songsData.songs.filter(s => !this.usedSongs.has(s.youtubeId));

        if (availableSongs.length === 0) {
            this.usedSongs.clear();
            return this.drawSong();
        }

        const song = availableSongs[Math.floor(Math.random() * availableSongs.length)];
        this.usedSongs.add(song.youtubeId);
        this.currentSong = song;
        this.turnPhase = 'listening';

        return {
            youtubeId: song.youtubeId,
        };
    }

    startPlacingPhase() {
        this.turnPhase = 'placing';
    }

    checkPlacement(userId, position) {
        const player = this.players.get(userId);
        if (!player || !this.currentSong) {
            return { valid: false, error: 'Invalid state' };
        }

        const songYear = this.currentSong.year;
        const timeline = player.timeline;

        let isCorrect = true;

        if (position > 0 && timeline[position - 1].year > songYear) {
            isCorrect = false;
        }

        if (position < timeline.length && timeline[position].year < songYear) {
            isCorrect = false;
        }

        return {
            valid: true,
            correct: isCorrect,
            song: this.currentSong
        };
    }

    placeCard(userId, position) {
        const result = this.checkPlacement(userId, position);

        if (!result.valid) {
            return result;
        }

        if (result.correct) {
            const player = this.players.get(userId);
            player.timeline.splice(position, 0, { ...this.currentSong });
            player.timeline.sort((a, b) => a.year - b.year);
            player.score++;

            this.updateLeaderboard(userId, player.name, true, false);

            if (player.score >= this.settings.cardsToWin) {
                return {
                    valid: true,
                    correct: true,
                    song: this.currentSong,
                    gameWon: true,
                    winner: player
                };
            }

            return {
                valid: true,
                correct: true,
                song: this.currentSong,
                newTimeline: player.timeline
            };
        } else {
            this.turnPhase = 'stealing';
            this.stealQueue = this.playerOrder.filter(id => id !== userId);
            this.currentStealerIndex = 0;

            this.updateLeaderboard(userId, this.players.get(userId)?.name, false, false);

            return {
                valid: true,
                correct: false,
                song: this.currentSong,
                canSteal: this.stealQueue.length > 0
            };
        }
    }

    stealCard(userId, position) {
        if (this.turnPhase !== 'stealing') {
            return { valid: false, error: 'Not in stealing phase' };
        }

        const currentStealerId = this.stealQueue[this.currentStealerIndex];
        if (userId !== currentStealerId) {
            return { valid: false, error: 'Not your turn to steal' };
        }

        const result = this.checkPlacement(userId, position);

        if (!result.valid) {
            return result;
        }

        if (result.correct) {
            const player = this.players.get(userId);
            player.timeline.splice(position, 0, { ...this.currentSong });
            player.timeline.sort((a, b) => a.year - b.year);
            player.score++;

            this.updateLeaderboard(userId, player.name, true, true);

            if (player.score >= this.settings.cardsToWin) {
                return {
                    valid: true,
                    correct: true,
                    stolen: true,
                    song: this.currentSong,
                    gameWon: true,
                    winner: player
                };
            }

            return {
                valid: true,
                correct: true,
                stolen: true,
                song: this.currentSong,
                newTimeline: player.timeline
            };
        } else {
            this.updateLeaderboard(userId, this.players.get(userId)?.name, false, true);

            this.currentStealerIndex++;

            if (this.currentStealerIndex >= this.stealQueue.length) {
                return {
                    valid: true,
                    correct: false,
                    noMoreStealers: true,
                    song: this.currentSong
                };
            }

            return {
                valid: true,
                correct: false,
                nextStealer: this.stealQueue[this.currentStealerIndex]
            };
        }
    }

    passSteal(userId) {
        if (this.turnPhase !== 'stealing') {
            return { valid: false, error: 'Not in stealing phase' };
        }

        const currentStealerId = this.stealQueue[this.currentStealerIndex];
        if (userId !== currentStealerId) {
            return { valid: false, error: 'Not your turn to steal' };
        }

        this.currentStealerIndex++;

        if (this.currentStealerIndex >= this.stealQueue.length) {
            return {
                valid: true,
                noMoreStealers: true,
                song: this.currentSong
            };
        }

        return {
            valid: true,
            nextStealer: this.stealQueue[this.currentStealerIndex]
        };
    }

    nextTurn() {
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.playerOrder.length;
        this.currentSong = null;
        this.turnPhase = 'listening';
        this.stealQueue = [];
        this.currentStealerIndex = 0;

        return this.getCurrentPlayer();
    }

    updateLeaderboard(userId, userName, correct, wasSteal) {
        if (!leaderboard.players[userId]) {
            leaderboard.players[userId] = {
                oderId: userId,
                displayName: userName,
                gamesPlayed: 0,
                gamesWon: 0,
                cardsWon: 0,
                correctPlacements: 0,
                wrongPlacements: 0,
                successfulSteals: 0,
                failedSteals: 0,
                winStreak: 0,
                bestWinStreak: 0,
                lastPlayed: Date.now()
            };
        }

        const stats = leaderboard.players[userId];
        stats.displayName = userName;
        stats.lastPlayed = Date.now();

        if (wasSteal) {
            if (correct) {
                stats.successfulSteals++;
                stats.cardsWon++;
            } else {
                stats.failedSteals++;
            }
        } else {
            if (correct) {
                stats.correctPlacements++;
                stats.cardsWon++;
            } else {
                stats.wrongPlacements++;
            }
        }

        debouncedSaveLeaderboard();
    }

    endGame(winnerId) {
        this.state = 'ended';

        for (const [playerId, player] of this.players) {
            if (leaderboard.players[playerId]) {
                const stats = leaderboard.players[playerId];
                stats.gamesPlayed++;
                if (playerId === winnerId) {
                    stats.gamesWon++;
                    stats.winStreak = (stats.winStreak || 0) + 1;
                    stats.bestWinStreak = Math.max(stats.bestWinStreak || 0, stats.winStreak);
                } else {
                    stats.winStreak = 0;
                }
            }
        }

        debouncedSaveLeaderboard();
    }

    getPublicState() {
        const players = [];
        for (const [id, player] of this.players) {
            players.push({
                id: player.id,
                name: player.name,
                score: player.score,
                timelineCount: player.timeline.length,
                connected: player.connected
            });
        }

        const spectators = [];
        for (const [id, spec] of this.spectators) {
            spectators.push({ id: spec.id, name: spec.name });
        }

        return {
            id: this.id,
            name: this.name,
            hostId: this.hostId,
            hostName: this.hostName,
            state: this.state,
            players,
            spectators,
            settings: this.settings,
            currentPlayerId: this.getCurrentPlayer()?.id,
            turnPhase: this.turnPhase,
            currentStealerId: this.turnPhase === 'stealing' ? this.stealQueue[this.currentStealerIndex] : null
        };
    }

    getPlayerTimeline(userId) {
        const player = this.players.get(userId);
        return player ? player.timeline : [];
    }
}

// Room management
const rooms = new Map();

export function createRoom(id, name, hostId, hostName, settings) {
    const room = new HitsterRoom(id, name, hostId, hostName, settings);
    rooms.set(id, room);
    return room;
}

export function getRoom(roomId) {
    return rooms.get(roomId);
}

export function deleteRoom(roomId) {
    rooms.delete(roomId);
}

export function getRoomList() {
    const list = [];
    for (const [id, room] of rooms) {
        if (room.state !== 'ended') {
            list.push({
                id: room.id,
                name: room.name,
                hostName: room.hostName,
                playerCount: room.players.size,
                maxPlayers: room.settings.maxPlayers,
                state: room.state,
                cardsToWin: room.settings.cardsToWin
            });
        }
    }
    return list;
}

export function getLeaderboard() {
    const players = Object.values(leaderboard.players);

    return players.map(p => {
        const totalPlacements = p.correctPlacements + p.wrongPlacements;
        const totalSteals = p.successfulSteals + p.failedSteals;
        const placementRate = totalPlacements > 0 ? p.correctPlacements / totalPlacements : 0;
        const stealRate = totalSteals > 0 ? p.successfulSteals / totalSteals : 0;
        const winRate = p.gamesPlayed > 0 ? p.gamesWon / p.gamesPlayed : 0;

        const skillRating = Math.round(
            (winRate * 40) +
            (placementRate * 30) +
            (stealRate * 20) +
            Math.min(p.cardsWon / 10, 10)
        );

        return {
            oderId: p.oderId,
            displayName: p.displayName,
            gamesPlayed: p.gamesPlayed,
            gamesWon: p.gamesWon,
            cardsWon: p.cardsWon,
            correctPlacements: p.correctPlacements,
            wrongPlacements: p.wrongPlacements,
            successfulSteals: p.successfulSteals,
            failedSteals: p.failedSteals,
            placementRate: Math.round(placementRate * 100),
            stealRate: Math.round(stealRate * 100),
            winRate: Math.round(winRate * 100),
            winStreak: p.winStreak || 0,
            bestWinStreak: p.bestWinStreak || 0,
            skillRating,
            lastPlayed: p.lastPlayed
        };
    }).sort((a, b) => b.skillRating - a.skillRating);
}

export { HitsterRoom };
