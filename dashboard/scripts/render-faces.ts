/**
 * Renders the bot faces to SVG files, so the drawing can be looked at.
 *
 * Not a test: a tool. Run it with `npx vite-node scripts/render-faces.ts`
 * from the dashboard directory, then open the files in `out/`.
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

function faceSvg(opts: {
  shape: string;
  color: string;
  expression: string;
  size?: number;
  t?: number;
}): string {
  const { shape, color, expression, size = 120, t = 1 } = opts;
  const radii = SHAPE_BY_ID.get(shape)?.radii ?? null;
  const expr = EXPRESSION_BY_ID.get(expression) ?? null;
  const ink = COLOR_BY_ID.get(color)?.hex ?? "#0a0a0c";
  const plate = luminance(ink) > 0.45 ? PLATE_DARK : PLATE_LIGHT;
  const engine = new BotEngine(RAYON, "idle", radii, expr);
  const frame = engine.sample(t);
  const half = DEMI_CORPS;
  const eyes = frame.eyes
    .map(
      (e) =>
        `<path d="${e.d}" transform="${e.matrix}" opacity="${e.alpha}" fill="#000"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-half} ${-half} ${half * 2} ${half * 2}">
  <defs><mask id="m" maskUnits="userSpaceOnUse" x="${-half}" y="${-half}" width="${half * 2}" height="${half * 2}">
    <path d="${frame.bodyPath}" fill="#fff"/>${eyes}
  </mask></defs>
  <rect x="${-half}" y="${-half}" width="${half * 2}" height="${half * 2}" rx="${half * 0.28}" fill="${plate}"/>
  <g mask="url(#m)"><rect x="${-half}" y="${-half}" width="${half * 2}" height="${half * 2}" fill="${ink}"/></g>
</svg>`;
}

mkdirSync("out", { recursive: true });

// One file per shape, in the default colour and expression.
for (const shape of SHAPE_BY_ID.keys()) {
  writeFileSync(
    `out/shape-${shape}.svg`,
    faceSvg({ shape, color: "encre", expression: "neutre" }),
  );
}

// One file per expression, on the default body.
for (const expression of EXPRESSION_BY_ID.keys()) {
  writeFileSync(
    `out/expr-${expression}.svg`,
    faceSvg({ shape: "cercle", color: "encre", expression }),
  );
}

// The palette, on the default body.
for (const color of COLOR_BY_ID.keys()) {
  writeFileSync(
    `out/color-${color}.svg`,
    faceSvg({ shape: "cercle", color, expression: "neutre" }),
  );
}

console.log("wrote out/*.svg");
