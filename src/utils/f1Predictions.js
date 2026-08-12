import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetch } from 'undici';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'f1Predictions.json');

const RACES = [
  { round: 1, name: 'Australian Grand Prix', circuit: 'Albert Park Grand Prix Circuit', location: 'Melbourne, Australia', date: '2026-03-08T04:00:00Z', sprint: false },
  { round: 2, name: 'Chinese Grand Prix', circuit: 'Shanghai International Circuit', location: 'Shanghai, China', date: '2026-03-15T07:00:00Z', sprint: true },
  { round: 3, name: 'Japanese Grand Prix', circuit: 'Suzuka International Racing Course', location: 'Suzuka, Japan', date: '2026-03-29T05:00:00Z', sprint: false },
  { round: 4, name: 'Bahrain Grand Prix', circuit: 'Bahrain International Circuit', location: 'Sakhir, Bahrain', date: '2026-04-12T15:00:00Z', sprint: false },
  { round: 5, name: 'Saudi Arabian Grand Prix', circuit: 'Jeddah Corniche Circuit', location: 'Jeddah, Saudi Arabia', date: '2026-04-19T17:00:00Z', sprint: false },
  { round: 6, name: 'Miami Grand Prix', circuit: 'Miami International Autodrome', location: 'Miami, United States', date: '2026-05-03T20:00:00Z', sprint: true },
  { round: 7, name: 'Canadian Grand Prix', circuit: 'Circuit Gilles Villeneuve', location: 'Montreal, Canada', date: '2026-05-24T20:00:00Z', sprint: true },
  { round: 8, name: 'Monaco Grand Prix', circuit: 'Circuit de Monaco', location: 'Monte Carlo, Monaco', date: '2026-06-07T13:00:00Z', sprint: false },
  { round: 9, name: 'Spanish Grand Prix', circuit: 'Circuit de Barcelona-Catalunya', location: 'Barcelona, Spain', date: '2026-06-14T13:00:00Z', sprint: false },
  { round: 10, name: 'Austrian Grand Prix', circuit: 'Red Bull Ring', location: 'Spielberg, Austria', date: '2026-06-28T13:00:00Z', sprint: false },
  { round: 11, name: 'British Grand Prix', circuit: 'Silverstone Circuit', location: 'Silverstone, United Kingdom', date: '2026-07-05T14:00:00Z', sprint: true },
  { round: 12, name: 'Belgian Grand Prix', circuit: 'Circuit de Spa-Francorchamps', location: 'Spa-Francorchamps, Belgium', date: '2026-07-19T13:00:00Z', sprint: false },
  { round: 13, name: 'Hungarian Grand Prix', circuit: 'Hungaroring', location: 'Budapest, Hungary', date: '2026-07-26T13:00:00Z', sprint: false },
  { round: 14, name: 'Dutch Grand Prix', circuit: 'Circuit Zandvoort', location: 'Zandvoort, Netherlands', date: '2026-08-23T13:00:00Z', sprint: true },
  { round: 15, name: 'Italian Grand Prix', circuit: 'Autodromo Nazionale Monza', location: 'Monza, Italy', date: '2026-09-06T13:00:00Z', sprint: false },
  { round: 16, name: 'Spanish Grand Prix (Madrid)', circuit: 'Circuit de Madrid', location: 'Madrid, Spain', date: '2026-09-13T13:00:00Z', sprint: false },
  { round: 17, name: 'Azerbaijan Grand Prix', circuit: 'Baku City Circuit', location: 'Baku, Azerbaijan', date: '2026-09-26T11:00:00Z', sprint: false },
  { round: 18, name: 'Singapore Grand Prix', circuit: 'Marina Bay Street Circuit', location: 'Singapore', date: '2026-10-11T12:00:00Z', sprint: true },
  { round: 19, name: 'United States Grand Prix', circuit: 'Circuit of the Americas', location: 'Austin, United States', date: '2026-10-25T20:00:00Z', sprint: false },
  { round: 20, name: 'Mexico City Grand Prix', circuit: 'Autodromo Hermanos Rodriguez', location: 'Mexico City, Mexico', date: '2026-11-01T20:00:00Z', sprint: false },
  { round: 21, name: 'Brazilian Grand Prix', circuit: 'Autodromo Jose Carlos Pace', location: 'Sao Paulo, Brazil', date: '2026-11-08T17:00:00Z', sprint: false },
  { round: 22, name: 'Las Vegas Grand Prix', circuit: 'Las Vegas Strip Circuit', location: 'Las Vegas, United States', date: '2026-11-22T06:00:00Z', sprint: false },
  { round: 23, name: 'Qatar Grand Prix', circuit: 'Lusail International Circuit', location: 'Doha, Qatar', date: '2026-11-29T16:00:00Z', sprint: false },
  { round: 24, name: 'Abu Dhabi Grand Prix', circuit: 'Yas Marina Circuit', location: 'Abu Dhabi, United Arab Emirates', date: '2026-12-06T13:00:00Z', sprint: false },
];

const DRIVERS = [
  { id: 'verstappen', name: 'Max Verstappen', number: 1, constructor: 'Red Bull', teamColor: '#3671C6' },
  { id: 'lawson', name: 'Liam Lawson', number: 30, constructor: 'Red Bull', teamColor: '#3671C6' },
  { id: 'norris', name: 'Lando Norris', number: 4, constructor: 'McLaren', teamColor: '#FF8000' },
  { id: 'piastri', name: 'Oscar Piastri', number: 81, constructor: 'McLaren', teamColor: '#FF8000' },
  { id: 'leclerc', name: 'Charles Leclerc', number: 16, constructor: 'Ferrari', teamColor: '#E8002D' },
  { id: 'hamilton', name: 'Lewis Hamilton', number: 44, constructor: 'Ferrari', teamColor: '#E8002D' },
  { id: 'russell', name: 'George Russell', number: 63, constructor: 'Mercedes', teamColor: '#27F4D2' },
  { id: 'antonelli', name: 'Kimi Antonelli', number: 12, constructor: 'Mercedes', teamColor: '#27F4D2' },
  { id: 'alonso', name: 'Fernando Alonso', number: 14, constructor: 'Aston Martin', teamColor: '#229971' },
  { id: 'stroll', name: 'Lance Stroll', number: 18, constructor: 'Aston Martin', teamColor: '#229971' },
  { id: 'gasly', name: 'Pierre Gasly', number: 10, constructor: 'Alpine', teamColor: '#0093CC' },
  { id: 'doohan', name: 'Jack Doohan', number: 7, constructor: 'Alpine', teamColor: '#0093CC' },
  { id: 'sainz', name: 'Carlos Sainz', number: 55, constructor: 'Williams', teamColor: '#64C4FF' },
  { id: 'albon', name: 'Alex Albon', number: 23, constructor: 'Williams', teamColor: '#64C4FF' },
  { id: 'tsunoda', name: 'Yuki Tsunoda', number: 22, constructor: 'RB', teamColor: '#6692FF' },
  { id: 'hadjar', name: 'Isack Hadjar', number: 6, constructor: 'RB', teamColor: '#6692FF' },
  { id: 'hulkenberg', name: 'Nico Hulkenberg', number: 27, constructor: 'Sauber', teamColor: '#52E252' },
  { id: 'bortoleto', name: 'Gabriel Bortoleto', number: 5, constructor: 'Sauber', teamColor: '#52E252' },
  { id: 'ocon', name: 'Esteban Ocon', number: 31, constructor: 'Haas', teamColor: '#B6BABD' },
  { id: 'bearman', name: 'Oliver Bearman', number: 87, constructor: 'Haas', teamColor: '#B6BABD' },
];

// --- Persistence ---

function loadData() {
  return loadJsonSync(DATA_FILE, { predictions: {}, results: {}, standings: {} });
}

function saveData(data) {
  saveJsonSync(DATA_FILE, data);
}

// --- Exports ---

export function getDrivers() {
  return DRIVERS;
}

export function getRaces(userId) {
  const data = loadData();
  return RACES.map(race => {
    const roundStr = String(race.round);
    const hasPrediction = !!(userId && data.predictions[roundStr]?.[userId]);
    const hasResults = !!data.results[roundStr];
    const locked = isRaceLocked(race.round);
    return { ...race, hasPrediction, hasResults, locked };
  });
}

export function submitPrediction(userId, displayName, avatarHash, round, picks) {
  const roundStr = String(round);
  const race = RACES.find(r => r.round === Number(round));
  if (!race) return { success: false, error: 'Invalid round' };

  if (isRaceLocked(round)) return { success: false, error: 'Predictions are closed for this race' };

  const { p1, p2, p3, fastestLap } = picks;

  // Validate driver IDs
  const validIds = DRIVERS.map(d => d.id);
  for (const driverId of [p1, p2, p3, fastestLap]) {
    if (!validIds.includes(driverId)) {
      return { success: false, error: `Invalid driver: ${driverId}` };
    }
  }

  // No duplicate drivers in podium positions
  if (new Set([p1, p2, p3]).size !== 3) {
    return { success: false, error: 'P1, P2, and P3 must be different drivers' };
  }

  const data = loadData();
  if (!data.predictions[roundStr]) data.predictions[roundStr] = {};

  data.predictions[roundStr][userId] = {
    displayName,
    avatarHash,
    p1,
    p2,
    p3,
    fastestLap,
    submittedAt: Date.now()
  };

  saveData(data);
  return { success: true, prediction: data.predictions[roundStr][userId] };
}

export function getPredictions(round) {
  const data = loadData();
  const roundStr = String(round);
  const predictions = data.predictions[roundStr] || {};

  // Enrich with driver names
  return Object.entries(predictions).map(([userId, pred]) => ({
    userId,
    displayName: pred.displayName,
    avatarHash: pred.avatarHash,
    p1: enrichDriver(pred.p1),
    p2: enrichDriver(pred.p2),
    p3: enrichDriver(pred.p3),
    fastestLap: enrichDriver(pred.fastestLap),
    submittedAt: pred.submittedAt
  }));
}

export function getUserPrediction(userId, round) {
  const data = loadData();
  const roundStr = String(round);
  const pred = data.predictions[roundStr]?.[userId];
  if (!pred) return null;

  return {
    p1: enrichDriver(pred.p1),
    p2: enrichDriver(pred.p2),
    p3: enrichDriver(pred.p3),
    fastestLap: enrichDriver(pred.fastestLap),
    submittedAt: pred.submittedAt
  };
}

export async function fetchAndScoreResults(round) {
  const roundStr = String(round);
  const race = RACES.find(r => r.round === Number(round));
  if (!race) throw new Error('Invalid round');

  const res = await fetch(`https://api.jolpi.ca/ergast/f1/2026/${round}/results/?format=json`);
  if (!res.ok) throw new Error(`Jolpica API error: HTTP ${res.status}`);
  const apiData = await res.json();

  const races = apiData?.MRData?.RaceTable?.Races;
  if (!races || races.length === 0) throw new Error('No results available for this race yet');

  const results = races[0].Results;
  if (!results || results.length === 0) throw new Error('No results available for this race yet');

  const positions = results.map(r => ({
    position: parseInt(r.position),
    driverId: r.Driver.driverId,
    name: `${r.Driver.givenName} ${r.Driver.familyName}`,
    constructor: r.Constructor.name
  }));

  const fastestLapResult = results.find(r => r.FastestLap?.rank === '1');
  const fastestLap = fastestLapResult ? {
    driverId: fastestLapResult.Driver.driverId,
    name: `${fastestLapResult.Driver.givenName} ${fastestLapResult.Driver.familyName}`
  } : null;

  const data = loadData();

  data.results[roundStr] = {
    positions,
    fastestLap,
    fetchedAt: Date.now(),
    scored: true
  };

  // Score each user's predictions
  const roundPredictions = data.predictions[roundStr] || {};
  const actualP1 = positions[0]?.driverId;
  const actualP2 = positions[1]?.driverId;
  const actualP3 = positions[2]?.driverId;
  const actualPodium = [actualP1, actualP2, actualP3];
  const actualFL = fastestLap?.driverId;

  for (const [userId, pred] of Object.entries(roundPredictions)) {
    let points = 0;
    let correctWinner = 0;
    let correctPodiums = 0;
    let correctFastestLap = 0;

    // Exact position matches
    if (pred.p1 === actualP1) { points += 25; correctWinner = 1; correctPodiums++; }
    else if (actualPodium.includes(pred.p1)) { points += 5; correctPodiums++; }

    if (pred.p2 === actualP2) { points += 18; correctPodiums++; }
    else if (actualPodium.includes(pred.p2)) { points += 5; correctPodiums++; }

    if (pred.p3 === actualP3) { points += 15; correctPodiums++; }
    else if (actualPodium.includes(pred.p3)) { points += 5; correctPodiums++; }

    // Perfect podium bonus
    let perfectPodium = 0;
    if (pred.p1 === actualP1 && pred.p2 === actualP2 && pred.p3 === actualP3) {
      points += 10;
      perfectPodium = 1;
    }

    // Fastest lap
    if (actualFL && pred.fastestLap === actualFL) {
      points += 10;
      correctFastestLap = 1;
    }

    // Update standings
    if (!data.standings[userId]) {
      data.standings[userId] = {
        displayName: pred.displayName,
        avatarHash: pred.avatarHash,
        totalPoints: 0,
        racesParticipated: 0,
        correctWinners: 0,
        correctPodiums: 0,
        correctFastestLaps: 0,
        perfectPodiums: 0,
        raceScores: {}
      };
    }

    const standing = data.standings[userId];
    // If previously scored for this round, subtract old score first
    if (standing.raceScores[roundStr] !== undefined) {
      standing.totalPoints -= standing.raceScores[roundStr];
      standing.racesParticipated -= 1;
    }

    standing.displayName = pred.displayName;
    standing.avatarHash = pred.avatarHash;
    standing.totalPoints += points;
    standing.racesParticipated += 1;
    standing.correctWinners += correctWinner;
    standing.correctPodiums += correctPodiums;
    standing.correctFastestLaps += correctFastestLap;
    standing.perfectPodiums += perfectPodium;
    standing.raceScores[roundStr] = points;
  }

  saveData(data);
  return { positions, fastestLap, race: race.name };
}

export function getStandings() {
  const data = loadData();
  return Object.entries(data.standings)
    .map(([userId, s]) => ({ userId, ...s }))
    .sort((a, b) => b.totalPoints - a.totalPoints);
}

export function getRaceResults(round) {
  const data = loadData();
  const roundStr = String(round);
  const results = data.results[roundStr];
  if (!results) return null;

  const race = RACES.find(r => r.round === Number(round));

  // Get scored predictions for this round
  const predictions = Object.entries(data.predictions[roundStr] || {}).map(([userId, pred]) => ({
    userId,
    displayName: pred.displayName,
    score: data.standings[userId]?.raceScores?.[roundStr] || 0
  })).sort((a, b) => b.score - a.score);

  return {
    race: race ? { round: race.round, name: race.name, circuit: race.circuit } : null,
    positions: results.positions,
    fastestLap: results.fastestLap,
    predictions
  };
}

export function isRaceLocked(round) {
  const race = RACES.find(r => r.round === Number(round));
  if (!race) return true;

  // Lock predictions 1 hour before race start
  const lockTime = new Date(race.date).getTime() - (60 * 60 * 1000);
  return Date.now() >= lockTime;
}

// --- Helpers ---

function enrichDriver(driverId) {
  const driver = DRIVERS.find(d => d.id === driverId);
  if (!driver) return { id: driverId, name: driverId, constructor: 'Unknown', teamColor: '#999' };
  return { id: driver.id, name: driver.name, constructor: driver.constructor, teamColor: driver.teamColor };
}
