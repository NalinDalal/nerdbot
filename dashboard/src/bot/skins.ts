import { PROFILE_SAMPLES } from "./profiles";
import {
  hullOfCircles,
  profileFromPolygon,
  regularPolygonProfile,
  superellipseProfile,
  unionOfCirclesProfile,
} from "./shape";

/**
 * The shapes and colours offered by the bot customiser.
 *
 * Unlike the animated silhouettes (`profiles.ts`), these are NOT measured off
 * the video: they are built analytically from the original customiser's
 * grid. Two distinct sources, on purpose — the animated states must stay
 * faithful to the video, the base shapes are a user choice.
 *
 * Ported from `bloub` (MIT, jeremy-prt/bloub).
 */

/**
 * The ids are enumerated rather than inferred from the array: that is what
 * lets the type-checker verify that every shape has an entry in the
 * catalogue. A `as const` on the array would have the same effect but makes
 * `radii` readonly, and the engine hands it over as-is.
 */
export type ShapeId =
  | "cercle"
  | "galet"
  | "squircle"
  | "capsule"
  | "triangle"
  | "hexagone"
  | "nuage"
  | "goutte";

export interface BotShape {
  id: ShapeId;
  radii: number[];
}

/** Brings the maximum radius back to `max` so every shape weighs the same to the eye. */
function normalize(radii: number[], max = 1): number[] {
  const peak = Math.max(...radii);
  if (peak <= 0) return radii;
  const k = max / peak;
  return radii.map((r) => r * k);
}

const ANGLES = Array.from({ length: PROFILE_SAMPLES }, (_, i) => (i / PROFILE_SAMPLES) * Math.PI * 2);

/** Pebble: a circle warped by two low harmonics, so irregular but smooth. */
const pebble = normalize(
  ANGLES.map((a) => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)),
  1.02,
);

/** Cloud: union of bumps, wide at the bottom, two lobes at the top. */
const cloud = normalize(
  unionOfCirclesProfile([
    { x: -0.44, y: 0.2, r: 0.54 },
    { x: 0.46, y: 0.2, r: 0.5 },
    { x: 0.02, y: 0.3, r: 0.6 },
    { x: -0.24, y: -0.3, r: 0.48 },
    { x: 0.3, y: -0.24, r: 0.44 },
  ]),
  1.02,
);

/** Droplet: a big disc at the bottom, a tapered point at the top. */
const droplet = normalize(
  profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05), 0, 0),
  1.04,
);

/** Layered capsule: the hull of two discs side by side. */
const capsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62), 0, 0);

export const SHAPES: BotShape[] = [
  { id: "cercle", radii: new Array(PROFILE_SAMPLES).fill(1) },
  { id: "galet", radii: pebble },
  // 1.15 and not 1.02: on a superellipse the maximum radius is the diagonal,
  // so normalising on it gives a shape that looks smaller than the circle.
  { id: "squircle", radii: normalize(superellipseProfile(4.2), 1.15) },
  { id: "capsule", radii: capsule },
  // -90deg: one vertex towards the top of the screen (y points down)
  { id: "triangle", radii: regularPolygonProfile(3, 1.12, 0.34, -90) },
  // 0deg: vertices left and right, so the top and bottom edges are flat
  { id: "hexagone", radii: regularPolygonProfile(6, 1.04, 0.26, 0) },
  { id: "nuage", radii: cloud },
  { id: "goutte", radii: droplet },
];

// Indexed by `string` and not by `ShapeId`: callers look up with a value read
// from storage or a prop, so it is not validated.
export const SHAPE_BY_ID = new Map<string, BotShape>(SHAPES.map((s) => [s.id, s]));
export const DEFAULT_SHAPE = "cercle";

export type ColorId =
  | "encre"
  | "creme"
  | "brun"
  | "rouge"
  | "orange"
  | "ambre"
  | "vert"
  | "turquoise"
  | "bleu"
  | "violet"
  | "rose"
  | "gris";

export interface BotColor {
  id: ColorId;
  hex: string;
}

/** The original customiser's palette. */
export const COLORS: BotColor[] = [
  { id: "encre", hex: "#0a0a0c" },
  { id: "brun", hex: "#8b5e3c" },
  { id: "rouge", hex: "#e8483f" },
  { id: "orange", hex: "#f08a24" },
  { id: "ambre", hex: "#f0b429" },
  { id: "vert", hex: "#3ecf8e" },
  { id: "turquoise", hex: "#2fbfa0" },
  { id: "bleu", hex: "#3b93f0" },
  { id: "violet", hex: "#8b5cf6" },
  { id: "rose", hex: "#e152b0" },
  { id: "gris", hex: "#a3a3a3" },
  { id: "creme", hex: "#f1efe9" },
];

export const COLOR_BY_ID = new Map<string, BotColor>(COLORS.map((c) => [c.id, c]));
export const DEFAULT_COLOR = "encre";

/** Mixes two hex colours. Used for the depth haze of the particles. */
export function mixHex(from: string, to: string, t: number): string {
  const parse = (h: string) => {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  const a = parse(from);
  const b = parse(to);
  const c = a.map((x, i) => Math.round(x + (b[i]! - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
