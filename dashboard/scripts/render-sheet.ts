/**
 * Builds one contact sheet of every face, so the whole catalogue can be
 * looked at in a single image.
 *
 * A tool, not a test: `npx vite-node scripts/render-sheet.ts`, then open
 * `out/sheet.png`.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { BotEngine } from "../src/bot/engine";
import { EXPRESSION_BY_ID } from "../src/bot/expressions";
import { COLOR_BY_ID, SHAPE_BY_ID } from "../src/bot/skins";
import { RAYON, DEMI_CORPS } from "../src/bot/repere";

const PLATE_LIGHT = "#f2f3f2";
const PLATE_DARK = "#0c1116";

function luminance(hex: string): number {
  const v = parseInt(hex.replace("#", ""), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function inner(
  shape: string,
  color: string,
  expression: string,
  t = 1,
): { body: string; eyes: string; ink: string; plate: string } {
  const radii = SHAPE_BY_ID.get(shape)?.radii ?? null;
  const expr = EXPRESSION_BY_ID.get(expression) ?? null;
  const ink = COLOR_BY_ID.get(color)?.hex ?? "#0a0a0c";
  const plate = luminance(ink) > 0.45 ? PLATE_DARK : PLATE_LIGHT;
  const engine = new BotEngine(RAYON, "idle", radii, expr);
  const frame = engine.sample(t);
  const eyes = frame.eyes
    .map((e) => `<path d="${e.d}" transform="${e.matrix}" opacity="${e.alpha}" fill="#000"/>`)
    .join("");
  return { body: frame.bodyPath, eyes, ink, plate };
}

type Cell = { label: string; shape: string; color: string; expression: string };

const shapes: Cell[] = [...SHAPE_BY_ID.keys()].map((shape) => ({
  label: shape,
  shape,
  color: "encre",
  expression: "neutre",
}));
const expressions: Cell[] = [...EXPRESSION_BY_ID.keys()].map((expression) => ({
  label: expression,
  shape: "cercle",
  color: "encre",
  expression,
}));
const colors: Cell[] = [...COLOR_BY_ID.keys()].map((color) => ({
  label: color,
  shape: "cercle",
  color,
  expression: "neutre",
}));

const cells = [...shapes, ...expressions, ...colors];
const COLS = 8;
const CELL = 150;
const PAD = 16;
const LABEL = 26;
const rows = Math.ceil(cells.length / COLS);
const width = COLS * (CELL + PAD) + PAD;
const height = rows * (CELL + LABEL + PAD) + PAD;

const body = cells
  .map((cell, i) => {
    const cx = PAD + (i % COLS) * (CELL + PAD);
    const cy = PAD + Math.floor(i / COLS) * (CELL + LABEL + PAD);
    const g = inner(cell.shape, cell.color, cell.expression);
    const s = CELL / (DEMI_CORPS * 2);
    return `<g transform="translate(${cx + CELL / 2} ${cy + CELL / 2}) scale(${s})">
      <rect x="${-DEMI_CORPS}" y="${-DEMI_CORPS}" width="${DEMI_CORPS * 2}" height="${DEMI_CORPS * 2}" rx="${DEMI_CORPS * 0.28}" fill="${g.plate}"/>
      <mask id="m${i}" maskUnits="userSpaceOnUse" x="${-DEMI_CORPS}" y="${-DEMI_CORPS}" width="${DEMI_CORPS * 2}" height="${DEMI_CORPS * 2}">
        <path d="${g.body}" fill="#fff"/>${g.eyes}
      </mask>
      <g mask="url(#m${i})"><rect x="${-DEMI_CORPS}" y="${-DEMI_CORPS}" width="${DEMI_CORPS * 2}" height="${DEMI_CORPS * 2}" fill="${g.ink}"/></g>
    </g>
    <text x="${cx + CELL / 2}" y="${cy + CELL + 18}" text-anchor="middle" font-family="Helvetica, Arial" font-size="13" fill="#b9c4cf">${cell.label}</text>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#12181c"/>
${body}
</svg>`;

mkdirSync("out", { recursive: true });
writeFileSync("out/sheet.svg", svg);
console.log("wrote out/sheet.svg");
