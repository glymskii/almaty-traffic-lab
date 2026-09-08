import * as THREE from "three";

/**
 * Sky/light palette by time of day (docs/tasks/T-27 §3: "цвет неба/фона и интенсивности света по
 * timeOfDayMin (день/вечер/ночь)"). Pure colour/number math, no THREE side effects and no
 * allocation on the hot path (`sampleTimeOfDay` writes into a caller-owned `TimeOfDaySample`) -
 * `renderer.ts`'s `applyTimeOfDay` is the only place that touches actual scene objects.
 */

interface Palette {
  background: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  ground: THREE.Color;
  /** 0 (invisible) .. 1 (full glow) - drives vehicles.ts's headlight emissive intensity. */
  headlight: number;
}

/** Every colour below is constructed once at module load, never per sample - `sampleTimeOfDay` is
 * allocation-free so it can run every render frame without adding to garbage-collector pressure. */
const DAY: Palette = {
  background: new THREE.Color("#dfe6ea"),
  hemiSky: new THREE.Color("#bcd6e8"),
  hemiGround: new THREE.Color("#4a463e"),
  hemiIntensity: 1.0,
  sunColor: new THREE.Color("#fff3e0"),
  sunIntensity: 1.3,
  ground: new THREE.Color("#6b7060"),
  headlight: 0,
};

const EVENING: Palette = {
  background: new THREE.Color("#c98a63"),
  hemiSky: new THREE.Color("#e2a06a"),
  hemiGround: new THREE.Color("#3a2f2a"),
  hemiIntensity: 0.75,
  sunColor: new THREE.Color("#ffb066"),
  sunIntensity: 0.9,
  ground: new THREE.Color("#4d453a"),
  headlight: 0.6,
};

const NIGHT: Palette = {
  background: new THREE.Color("#0d1220"),
  hemiSky: new THREE.Color("#25324a"),
  hemiGround: new THREE.Color("#0a0b10"),
  hemiIntensity: 0.3,
  sunColor: new THREE.Color("#8fa6c9"),
  sunIntensity: 0.2,
  ground: new THREE.Color("#23261f"),
  headlight: 1,
};

interface Keyframe {
  atMin: number;
  palette: Palette;
}

/** Anchors placed at the representative middle of each named phase (card §3: "день/вечер/ночь"); the
 * fourth entry is the first anchor's wrap-around copy so every `timeOfDayMin` falls inside a bracket. */
const NIGHT_ANCHOR_MIN = 120; // 02:00, the middle of the (21:00 .. 05:00) night span
const DAY_ANCHOR_MIN = 780; // 13:00
const EVENING_ANCHOR_MIN = 1170; // 19:30
const KEYFRAMES: readonly Keyframe[] = [
  { atMin: NIGHT_ANCHOR_MIN, palette: NIGHT },
  { atMin: DAY_ANCHOR_MIN, palette: DAY },
  { atMin: EVENING_ANCHOR_MIN, palette: EVENING },
  { atMin: NIGHT_ANCHOR_MIN + 1440, palette: NIGHT },
];

export interface TimeOfDaySample {
  background: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  ground: THREE.Color;
  headlight: number;
}

export function createTimeOfDaySample(): TimeOfDaySample {
  return {
    background: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
    sunColor: new THREE.Color(),
    sunIntensity: 1,
    ground: new THREE.Color(),
    headlight: 0,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps `timeOfDayMin` into `[KEYFRAMES[0].atMin, KEYFRAMES[last].atMin)` before bracketing it. */
function wrappedMinute(timeOfDayMin: number): number {
  const first = KEYFRAMES[0] as Keyframe;
  const span = 1440;
  let m = timeOfDayMin;
  while (m < first.atMin) m += span;
  while (m >= first.atMin + span) m -= span;
  return m;
}

/** Writes the interpolated day/evening/night palette for `timeOfDayMin` into `out` - no allocation. */
export function sampleTimeOfDay(timeOfDayMin: number, out: TimeOfDaySample): void {
  const m = wrappedMinute(timeOfDayMin);
  let a = KEYFRAMES[0] as Keyframe;
  let b = KEYFRAMES[KEYFRAMES.length - 1] as Keyframe;
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const from = KEYFRAMES[i] as Keyframe;
    const to = KEYFRAMES[i + 1] as Keyframe;
    if (m >= from.atMin && m <= to.atMin) {
      a = from;
      b = to;
      break;
    }
  }
  const span = b.atMin - a.atMin;
  const t = span > 0 ? (m - a.atMin) / span : 0;

  out.background.copy(a.palette.background).lerp(b.palette.background, t);
  out.hemiSky.copy(a.palette.hemiSky).lerp(b.palette.hemiSky, t);
  out.hemiGround.copy(a.palette.hemiGround).lerp(b.palette.hemiGround, t);
  out.sunColor.copy(a.palette.sunColor).lerp(b.palette.sunColor, t);
  out.ground.copy(a.palette.ground).lerp(b.palette.ground, t);
  out.hemiIntensity = lerp(a.palette.hemiIntensity, b.palette.hemiIntensity, t);
  out.sunIntensity = lerp(a.palette.sunIntensity, b.palette.sunIntensity, t);
  out.headlight = lerp(a.palette.headlight, b.palette.headlight, t);
}
