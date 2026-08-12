// One-time script to create Discord scheduled events for all 2026 F1 races
// Usage: node createF1Events.js           - Create all events with circuit map images
//        node createF1Events.js --delete   - Delete all F1 events, then recreate them

import { Client, GatewayIntentBits, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';
import 'dotenv/config';

const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.DISCORD_TOKEN;
const DELETE_FIRST = process.argv.includes('--delete');

const RACES = [
  {
    round: 1,
    name: '\u{1F1E6}\u{1F1FA} F1 Round 1: Australian Grand Prix',
    circuit: 'Albert Park Grand Prix Circuit',
    location: 'Melbourne, Australia',
    circuitLength: '5.278 km',
    date: '2026-03-08T04:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Albert_Park_Circuit_2021.svg/1920px-Albert_Park_Circuit_2021.svg.png',
    description: 'Street circuit winding around Albert Park Lake in Melbourne. Known for its fast, flowing layout through parkland with a mix of high-speed straights and challenging braking zones. The Australian GP has been a season opener multiple times and always delivers action.',
  },
  {
    round: 2,
    name: '\u{1F1E8}\u{1F1F3} F1 Round 2: Chinese Grand Prix',
    circuit: 'Shanghai International Circuit',
    location: 'Shanghai, China',
    circuitLength: '5.451 km',
    date: '2026-03-15T07:00:00Z',
    sprint: true,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Shanghai_International_Racing_Circuit_track_map.svg/1280px-Shanghai_International_Racing_Circuit_track_map.svg.png',
    description: 'Designed by Hermann Tilke, the Shanghai International Circuit features the iconic Turns 1-3 hairpin combination and a long back straight perfect for overtaking. The circuit\'s layout represents the Chinese character "shang" (above).',
  },
  {
    round: 3,
    name: '\u{1F1EF}\u{1F1F5} F1 Round 3: Japanese Grand Prix',
    circuit: 'Suzuka International Racing Course',
    location: 'Suzuka, Japan',
    circuitLength: '5.807 km',
    date: '2026-03-29T05:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Suzuka_circuit_map--2005.svg/1280px-Suzuka_circuit_map--2005.svg.png',
    description: 'One of Formula 1\'s most iconic and challenging circuits. Suzuka is unique with its figure-eight layout and legendary corners including the Esses, Degner curves, Spoon, and the fearsome 130R. A true drivers\' circuit.',
  },
  {
    round: 4,
    name: '\u{1F1E7}\u{1F1ED} F1 Round 4: Bahrain Grand Prix',
    circuit: 'Bahrain International Circuit',
    location: 'Sakhir, Bahrain',
    circuitLength: '5.412 km',
    date: '2026-04-12T15:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/29/Bahrain_International_Circuit--Grand_Prix_Layout.svg/1280px-Bahrain_International_Circuit--Grand_Prix_Layout.svg.png',
    description: 'Formula 1\'s first race in the Middle East, held under dramatic floodlights as a twilight-to-night event. The desert circuit features heavy braking zones, long straights, and abrasive sand that blows onto the track.',
  },
  {
    round: 5,
    name: '\u{1F1F8}\u{1F1E6} F1 Round 5: Saudi Arabian Grand Prix',
    circuit: 'Jeddah Corniche Circuit',
    location: 'Jeddah, Saudi Arabia',
    circuitLength: '6.174 km',
    date: '2026-04-19T17:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Jeddah_Street_Circuit_2021.svg/1280px-Jeddah_Street_Circuit_2021.svg.png',
    description: 'One of the fastest street circuits in Formula 1, running along the Jeddah waterfront. With 27 corners, high average speeds, and close barriers, it\'s one of the most demanding tracks on the calendar. Raced under floodlights at night.',
  },
  {
    round: 6,
    name: '\u{1F1FA}\u{1F1F8} F1 Round 6: Miami Grand Prix',
    circuit: 'Miami International Autodrome',
    location: 'Miami, United States',
    circuitLength: '5.412 km',
    date: '2026-05-03T20:00:00Z',
    sprint: true,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/49/Hard_Rock_Stadium_Circuit_2022.svg/1280px-Hard_Rock_Stadium_Circuit_2022.svg.png',
    description: 'Built around Hard Rock Stadium in Miami Gardens. This modern circuit combines long straights with technical sections, offering plenty of overtaking opportunities. The Miami GP brings F1 glamour to South Florida.',
  },
  {
    round: 7,
    name: '\u{1F1E8}\u{1F1E6} F1 Round 7: Canadian Grand Prix',
    circuit: 'Circuit Gilles Villeneuve',
    location: 'Montreal, Canada',
    circuitLength: '4.361 km',
    date: '2026-05-24T20:00:00Z',
    sprint: true,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/%C3%8Ele_Notre-Dame_%28Circuit_Gilles_Villeneuve%29.svg/1920px-%C3%8Ele_Notre-Dame_%28Circuit_Gilles_Villeneuve%29.svg.png',
    description: 'A semi-permanent circuit on \u{00CE}le Notre-Dame in the St. Lawrence River. Known for its long straights, heavy braking zones, and the infamous Wall of Champions at the final chicane. Consistently delivers unpredictable races.',
  },
  {
    round: 8,
    name: '\u{1F1F2}\u{1F1E8} F1 Round 8: Monaco Grand Prix',
    circuit: 'Circuit de Monaco',
    location: 'Monte Carlo, Monaco',
    circuitLength: '3.337 km',
    date: '2026-06-07T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Monte_Carlo_Formula_1_track_map.svg/1920px-Monte_Carlo_Formula_1_track_map.svg.png',
    description: 'The jewel in Formula 1\'s crown. This legendary street circuit winds through Monte Carlo\'s narrow streets, past the famous Casino, through the tunnel, and along the harbor. The most prestigious race in motorsport.',
  },
  {
    round: 9,
    name: '\u{1F1EA}\u{1F1F8} F1 Round 9: Gran Premio de Barcelona-Catalunya',
    circuit: 'Circuit de Barcelona-Catalunya',
    location: 'Barcelona, Spain',
    circuitLength: '4.657 km',
    date: '2026-06-14T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/Circuit_de_Catalunya_moto_2021.svg/1920px-Circuit_de_Catalunya_moto_2021.svg.png',
    description: 'A popular testing venue that teams know inside out. Features a variety of corner types from high-speed sweeps to tight hairpins. The demanding layout makes it a true benchmark for car performance.',
  },
  {
    round: 10,
    name: '\u{1F1E6}\u{1F1F9} F1 Round 10: Austrian Grand Prix',
    circuit: 'Red Bull Ring',
    location: 'Spielberg, Austria',
    circuitLength: '4.318 km',
    date: '2026-06-28T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Circuit_Red_Bull_Ring.svg/1280px-Circuit_Red_Bull_Ring.svg.png',
    description: 'A short, fast circuit set in the stunning Styrian mountains. Known for dramatic elevation changes, fast straights, and close racing. The compact layout means action is always visible and the atmosphere is electric.',
  },
  {
    round: 11,
    name: '\u{1F1EC}\u{1F1E7} F1 Round 11: British Grand Prix',
    circuit: 'Silverstone Circuit',
    location: 'Silverstone, United Kingdom',
    circuitLength: '5.891 km',
    date: '2026-07-05T14:00:00Z',
    sprint: true,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/b/bd/Silverstone_Circuit_2020.png',
    description: 'The home of British motorsport and the venue for the very first Formula 1 World Championship race in 1950. Legendary high-speed corners like Copse, Maggots, Becketts, and Stowe make it a true drivers\' circuit.',
  },
  {
    round: 12,
    name: '\u{1F1E7}\u{1F1EA} F1 Round 12: Belgian Grand Prix',
    circuit: 'Circuit de Spa-Francorchamps',
    location: 'Spa-Francorchamps, Belgium',
    circuitLength: '7.004 km',
    date: '2026-07-19T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/54/Spa-Francorchamps_of_Belgium.svg/1920px-Spa-Francorchamps_of_Belgium.svg.png',
    description: 'One of the greatest racing circuits in the world, set in the beautiful Ardennes forest. Famous for the fearsome Eau Rouge/Raidillon complex, the long Kemmel straight, and notoriously unpredictable weather. The longest circuit on the calendar.',
  },
  {
    round: 13,
    name: '\u{1F1ED}\u{1F1FA} F1 Round 13: Hungarian Grand Prix',
    circuit: 'Hungaroring',
    location: 'Budapest, Hungary',
    circuitLength: '4.381 km',
    date: '2026-07-26T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/91/Hungaroring.svg/960px-Hungaroring.svg.png',
    description: 'A tight, twisty circuit in a natural bowl near Budapest, often compared to Monaco without the walls. Overtaking is a challenge, putting a premium on qualifying and strategy. The hot Hungarian summer tests drivers\' fitness.',
  },
  {
    round: 14,
    name: '\u{1F1F3}\u{1F1F1} F1 Round 14: Dutch Grand Prix',
    circuit: 'Circuit Zandvoort',
    location: 'Zandvoort, Netherlands',
    circuitLength: '4.259 km',
    date: '2026-08-23T13:00:00Z',
    sprint: true,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Zandvoort_Circuit.png/1280px-Zandvoort_Circuit.png',
    description: 'A classic seaside circuit nestled in the Dutch sand dunes. Revived for modern F1 with unique banked corners in Turns 3 and 14. The passionate Dutch fans create one of the most vibrant atmospheres on the calendar.',
  },
  {
    round: 15,
    name: '\u{1F1EE}\u{1F1F9} F1 Round 15: Gran Premio d\'Italia',
    circuit: 'Autodromo Nazionale Monza',
    location: 'Monza, Italy',
    circuitLength: '5.793 km',
    date: '2026-09-06T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f8/Monza_track_map.svg/1280px-Monza_track_map.svg.png',
    description: 'The Temple of Speed. One of the oldest and fastest circuits in Formula 1, located in a stunning royal park near Milan. Known for its long straights, slipstreaming battles, and the legendary Parabolica. The Tifosi create an unmatched atmosphere.',
  },
  {
    round: 16,
    name: '\u{1F1EA}\u{1F1F8} F1 Round 16: Gran Premio de Espa\u{00F1}a',
    circuit: 'Circuit de Madrid',
    location: 'Madrid, Spain',
    circuitLength: '5.474 km',
    date: '2026-09-13T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/Madring_%282026%29.svg/960px-Madring_%282026%29.svg.png',
    description: 'A brand new circuit making its Formula 1 debut in 2026. Located in Madrid, this purpose-built track promises a modern, exciting layout designed for close racing. The first F1 race in the Spanish capital.',
  },
  {
    round: 17,
    name: '\u{1F1E6}\u{1F1FF} F1 Round 17: Azerbaijan Grand Prix',
    circuit: 'Baku City Circuit',
    location: 'Baku, Azerbaijan',
    circuitLength: '6.003 km',
    date: '2026-09-26T11:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/Baku_Formula_One_circuit_map.svg/3840px-Baku_Formula_One_circuit_map.svg.png',
    description: 'A spectacular street circuit through the streets of Baku, winding past the medieval Old City. Features F1\'s longest straight (over 2 km) and narrow, twisting sections that regularly produce dramatic, unpredictable races.',
  },
  {
    round: 18,
    name: '\u{1F1F8}\u{1F1EC} F1 Round 18: Singapore Grand Prix',
    circuit: 'Marina Bay Street Circuit',
    location: 'Singapore',
    circuitLength: '4.940 km',
    date: '2026-10-11T12:00:00Z',
    sprint: true,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Marina_Bay_circuit_2023.svg/960px-Marina_Bay_circuit_2023.svg.png',
    description: 'Formula 1\'s original night race, illuminated by over 1,500 light projectors. This demanding street circuit through Singapore\'s Marina Bay is one of the most physically challenging races, with extreme heat, humidity, and a bumpy surface.',
  },
  {
    round: 19,
    name: '\u{1F1FA}\u{1F1F8} F1 Round 19: United States Grand Prix',
    circuit: 'Circuit of the Americas',
    location: 'Austin, United States',
    circuitLength: '5.513 km',
    date: '2026-10-25T20:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a5/Austin_circuit.svg/3840px-Austin_circuit.svg.png',
    description: 'Purpose-built Formula 1 circuit in Austin, Texas. The dramatic uphill charge to Turn 1, a sequence inspired by Silverstone\'s Maggots-Becketts, and significant elevation changes make it one of the most complete modern circuits.',
  },
  {
    round: 20,
    name: '\u{1F1F2}\u{1F1FD} F1 Round 20: Gran Premio de la Ciudad de M\u{00E9}xico',
    circuit: 'Aut\u{00F3}dromo Hermanos Rodr\u{00ED}guez',
    location: 'Mexico City, Mexico',
    circuitLength: '4.304 km',
    date: '2026-11-01T20:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/36/Aut%C3%B3dromo_Hermanos_Rodr%C3%ADguez_2015.svg/960px-Aut%C3%B3dromo_Hermanos_Rodr%C3%ADguez_2015.svg.png',
    description: 'Located at 2,240m above sea level, the thin air challenges both engines and aerodynamics. The iconic Foro Sol stadium section, where 30,000+ fans create an incredible atmosphere, is one of F1\'s most memorable experiences.',
  },
  {
    round: 21,
    name: '\u{1F1E7}\u{1F1F7} F1 Round 21: Brazilian Grand Prix',
    circuit: 'Aut\u{00F3}dromo Jos\u{00E9} Carlos Pace (Interlagos)',
    location: 'S\u{00E3}o Paulo, Brazil',
    circuitLength: '4.309 km',
    date: '2026-11-08T17:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cf/Aut%C3%B3dromo_Jos%C3%A9_Carlos_Pace_%28AKA_Interlagos%29_track_map.svg/1920px-Aut%C3%B3dromo_Jos%C3%A9_Carlos_Pace_%28AKA_Interlagos%29_track_map.svg.png',
    description: 'A short, anti-clockwise circuit in S\u{00E3}o Paulo steeped in F1 history. Known for dramatic races, changeable weather, and passionate Brazilian fans. The elevation changes and flowing layout make it a fan and driver favorite.',
  },
  {
    round: 22,
    name: '\u{1F1FA}\u{1F1F8} F1 Round 22: Las Vegas Grand Prix',
    circuit: 'Las Vegas Strip Circuit',
    location: 'Las Vegas, United States',
    circuitLength: '6.201 km',
    date: '2026-11-22T06:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/43/2023_Las_Vegas_street_circuit.svg/1280px-2023_Las_Vegas_street_circuit.svg.png',
    description: 'A spectacular night race down the world-famous Las Vegas Strip. Cars blast past iconic casinos and hotels at high speed. The cool desert night air and long straights create a unique challenge. Pure F1 showmanship.',
  },
  {
    round: 23,
    name: '\u{1F1F6}\u{1F1E6} F1 Round 23: Qatar Grand Prix',
    circuit: 'Lusail International Circuit',
    location: 'Doha, Qatar',
    circuitLength: '5.419 km',
    date: '2026-11-29T16:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c7/Lusail_International_Circuit_2023.svg/1280px-Lusail_International_Circuit_2023.svg.png',
    description: 'A fast, flowing circuit in the desert north of Doha, originally built for MotoGP. The floodlit night race features a series of medium and high-speed corners that reward bravery and precision.',
  },
  {
    round: 24,
    name: '\u{1F1E6}\u{1F1EA} F1 Round 24: Abu Dhabi Grand Prix',
    circuit: 'Yas Marina Circuit',
    location: 'Abu Dhabi, United Arab Emirates',
    circuitLength: '5.281 km',
    date: '2026-12-06T13:00:00Z',
    sprint: false,
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/b/b0/Yas_Marina_Circuit.png',
    description: 'The traditional season finale, held as a stunning twilight-to-night race. The circuit passes under the iconic W Hotel, through a marina, and features a dramatic combination of straights and technical sections. Where champions are crowned.',
  },
];

const FETCH_HEADERS = { 'User-Agent': 'JerryBot/2.0 (Discord Bot; Circuit Images)' };

async function fetchImage(url) {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS });
    if (!res.ok) {
      console.log(`  Image fetch failed: HTTP ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 8 * 1024 * 1024) {
      console.log(`  Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB), skipping`);
      return null;
    }
    return buffer;
  } catch (e) {
    console.log(`  Could not fetch image: ${e.message}`);
    return null;
  }
}

function buildDescription(race) {
  const lines = [];

  lines.push(`\u{1F3C1} Round ${race.round} of 24 \u{2022} 2026 FIA Formula 1 World Championship`);
  if (race.sprint) {
    lines.push(`\u{26A1} Sprint Weekend`);
  }
  lines.push('');
  lines.push(`\u{1F3CE}\u{FE0F} ${race.circuit}`);
  lines.push(`\u{1F4CD} ${race.location}`);
  lines.push(`\u{1F4CF} Circuit Length: ${race.circuitLength}`);
  lines.push('');
  lines.push(race.description);

  return lines.join('\n');
}

async function deleteAllF1Events(guild) {
  console.log('Fetching existing scheduled events...');
  const events = await guild.scheduledEvents.fetch();
  const f1Events = events.filter(e => e.name.includes('F1 Round'));

  if (f1Events.size === 0) {
    console.log('No F1 events found to delete.\n');
    return;
  }

  console.log(`Found ${f1Events.size} F1 events to delete.\n`);

  let deleted = 0;
  for (const [, event] of f1Events) {
    try {
      console.log(`  Deleting: ${event.name}...`);
      await event.delete();
      deleted++;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`  Failed to delete "${event.name}": ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`\nDeleted ${deleted}/${f1Events.size} events.\n`);
}

async function main() {
  if (!TOKEN || !GUILD_ID) {
    console.error('Missing DISCORD_TOKEN or GUILD_ID in .env');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await client.login(TOKEN);
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);

  if (DELETE_FIRST) {
    console.log(`\nDeleting existing F1 events in: ${guild.name}\n`);
    await deleteAllF1Events(guild);
  }

  console.log(`Creating F1 events in: ${guild.name}\n`);

  let created = 0;
  let failed = 0;

  for (const race of RACES) {
    try {
      console.log(`[${race.round}/24] ${race.name}...`);

      const image = await fetchImage(race.imageUrl);
      if (image) {
        console.log(`  Found image (${(image.length / 1024).toFixed(0)}KB)`);
      } else {
        console.log(`  No image available, creating event without cover`);
      }

      const startTime = new Date(race.date);
      const endTime = new Date(startTime.getTime() + 2 * 60 * 60 * 1000); // Race ~2 hours

      await guild.scheduledEvents.create({
        name: race.name,
        description: buildDescription(race),
        scheduledStartTime: startTime,
        scheduledEndTime: endTime,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: `${race.circuit}, ${race.location}` },
        ...(image ? { image } : {}),
      });

      console.log(`  \u{2705} Created!`);
      created++;

      // Delay to respect Discord rate limits
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.error(`  \u{274C} Failed: ${e.message}`);
      failed++;
      // Longer delay after errors (might be rate limited)
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`\nDone! Created ${created} events, ${failed} failed.`);
  client.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
