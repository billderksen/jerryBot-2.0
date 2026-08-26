// hitlijn/tools/maak-hypegeluiden.mjs
// Genereert een 'hype'-geluidenpakket in clubstijl (airhorn, riser, drop, scratch,
// applaus, cash, buzzer, stabs) met ffmpeg-synthese. Alles zelf gemaakt, dus per
// definitie rechtenvrij — geen bron, geen licentie, geen naamsvermelding.
//
// Draaien: node hitlijn/tools/maak-hypegeluiden.mjs
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const uitvoeren = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../public/geluiden/kandidaten');
mkdirSync(OUT, { recursive: true });

// Elk recept is een compleet ffmpeg-filtergraph. 'lavfi'-bronnen: sine (toon),
// anoisesrc (ruis), aevalsrc (formule). Alles eindigt mono/44.1k op -1 dBFS.
const RECEPTEN = {
  // klassieke reggae/DJ-toeter: drie stemmen met vibrato en een korte staart
  'hype-airhorn': `-f lavfi -i "aevalsrc='0.9*sin(2*PI*466*t)+0.6*sin(2*PI*622*t)+0.4*sin(2*PI*932*t)':d=1.1"
    -af "vibrato=f=6:d=0.3,aeval='tanh(2.2*val(0))',highpass=f=300,afade=t=in:d=0.03,afade=t=out:st=0.85:d=0.25"`,

  // opbouwende sweep: chirp omhoog (aevalsrc kan wél met t rekenen) + ruis eronder
  'hype-riser': `-f lavfi -i "aevalsrc='0.6*sin(2*PI*(220+900*t*t)*t)':d=1.6" -f lavfi -i "anoisesrc=d=1.6:c=pink:a=0.5"
    -filter_complex "[0]volume='min(1,pow(t/1.6,2))':eval=frame[s];[1]volume='min(1,pow(t/1.6,3))*0.7':eval=frame[n];
    [s][n]amix=inputs=2:normalize=0,afade=t=out:st=1.45:d=0.15"`,

  // sub-drop: lage sinus die wegzakt, met een korte tik erop
  'hype-drop': `-f lavfi -i "sine=frequency=110:duration=1.4" -f lavfi -i "anoisesrc=d=0.12:c=white:a=0.5"
    -filter_complex "[0]asetrate=44100*1.0,volume='exp(-3*t)':eval=frame,
    aeval='tanh(1.6*val(0))',lowpass=f=180[sub];[1]highpass=f=1200,volume=0.5[tik];
    [sub][tik]amix=inputs=2:normalize=0"`,

  // scratch omhoog (pak-moment) en omlaag (neerleggen): chirp met ruwe rand
  'hype-scratch-op': `-f lavfi -i "aevalsrc='sin(2*PI*(300+5000*t)*t)*0.9':d=0.32"
    -af "aeval='tanh(2.5*val(0))',bandpass=f=1400:width_type=q:w=0.6,volume=4,afade=t=in:d=0.01,afade=t=out:st=0.26:d=0.06"`,
  'hype-scratch-neer': `-f lavfi -i "aevalsrc='sin(2*PI*(3200-5000*t)*t)*0.9':d=0.32"
    -af "aeval='tanh(2.5*val(0))',bandpass=f=1200:width_type=q:w=0.6,volume=4,afade=t=in:d=0.01,afade=t=out:st=0.26:d=0.06"`,

  // tape-stop: toonhoogte zakt weg (fout-moment) — als chirp geschreven
  'hype-tapestop': `-f lavfi -i "aevalsrc='sin(2*PI*(440-380*t/0.9)*t)*0.9':d=0.9"
    -af "volume='max(0,1-t*0.95)':eval=frame,lowpass=f=2600,aeval='tanh(1.6*val(0))'"`,

  // applaus: dichte reeks korte ruispulsen die uitdunt
  'hype-applaus': `-f lavfi -i "anoisesrc=d=2.2:c=white:a=0.8"
    -af "bandpass=f=1800:width_type=q:w=0.7,
    volume='0.25+0.75*random(0)':eval=frame,
    volume='min(1,t*6)*max(0,1-max(0,t-1.2)/1.0)':eval=frame,volume=2.4"`,

  // cash/munt: heldere belcluster
  'hype-cash': `-f lavfi -i "sine=frequency=1568:duration=0.5" -f lavfi -i "sine=frequency=2093:duration=0.5" -f lavfi -i "sine=frequency=2637:duration=0.5"
    -filter_complex "[0]volume='exp(-7*t)':eval=frame[a];[1]adelay=40|40,volume='exp(-8*t)':eval=frame,volume=0.8[b];
    [2]adelay=80|80,volume='exp(-9*t)':eval=frame,volume=0.6[c];[a][b][c]amix=inputs=3:normalize=0"`,

  // buzzer: harde afkeuring
  'hype-buzzer': `-f lavfi -i "sine=frequency=155:duration=0.6"
    -af "aeval='tanh(6*val(0))',tremolo=f=28:d=0.7,lowpass=f=2200,afade=t=out:st=0.45:d=0.15"`,

  // korte akkoord-stab (bevestigen) en een grotere variant (goed gelegd)
  'hype-stab': `-f lavfi -i "sine=frequency=523:duration=0.45" -f lavfi -i "sine=frequency=659:duration=0.45" -f lavfi -i "sine=frequency=784:duration=0.45"
    -filter_complex "[0][1][2]amix=inputs=3:normalize=0,aeval='tanh(1.8*val(0))',
    volume='exp(-6*t)':eval=frame,highpass=f=180"`,
  'hype-fanfare': `-f lavfi -i "sine=frequency=523:duration=1.6" -f lavfi -i "sine=frequency=659:duration=1.6" -f lavfi -i "sine=frequency=784:duration=1.6" -f lavfi -i "sine=frequency=1047:duration=1.6"
    -filter_complex "[0]volume='exp(-2.2*t)':eval=frame[a];[1]adelay=110|110,volume='exp(-2.2*t)':eval=frame[b];
    [2]adelay=220|220,volume='exp(-2.2*t)':eval=frame[c];[3]adelay=330|330,volume='exp(-1.6*t)':eval=frame[d];
    [a][b][c][d]amix=inputs=4:normalize=0,aeval='tanh(1.5*val(0))',highpass=f=200"`,

  // korte, droge tik met wat body (knopgeluid)
  'hype-tik': `-f lavfi -i "anoisesrc=d=0.06:c=white:a=0.7" -f lavfi -i "sine=frequency=900:duration=0.06"
    -filter_complex "[0]bandpass=f=2400:width_type=q:w=0.8[n];[1]volume='exp(-40*t)':eval=frame,volume=0.6[t];
    [n][t]amix=inputs=2:normalize=0,afade=t=out:st=0.045:d=0.015"`,
  'hype-tik-diep': `-f lavfi -i "sine=frequency=180:duration=0.09" -f lavfi -i "anoisesrc=d=0.05:c=white:a=0.4"
    -filter_complex "[0]volume='exp(-28*t)':eval=frame[a];[1]highpass=f=3000,volume=0.35[b];
    [a][b]amix=inputs=2:normalize=0,aeval='tanh(2*val(0))'"`,
};

let gemaakt = 0;
for (const [naam, recept] of Object.entries(RECEPTEN)) {
  const doel = join(OUT, `${naam}.mp3`);
  const args = ['-y', '-loglevel', 'error',
    ...recept.replace(/\s+/g, ' ').trim().match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, '')),
    '-ac', '1', '-ar', '44100', '-b:a', '128k', doel];
  try {
    await uitvoeren('ffmpeg', args);
    gemaakt++;
    console.log(`  ${naam}.mp3`);
  } catch (e) {
    console.error(`  MISLUKT ${naam}: ${String(e.stderr ?? e).slice(0, 200)}`);
  }
}
console.log(`${gemaakt}/${Object.keys(RECEPTEN).length} hype-geluiden gemaakt in ${OUT}`);
