import { DEFAULT_EXPRESSION, EXPRESSION_BY_ID } from "./expressions";
import { COLOR_BY_ID, DEFAULT_COLOR, DEFAULT_SHAPE, SHAPE_BY_ID, } from "./skins";
export const DEFAULT_FACE = {
    shape: DEFAULT_SHAPE,
    color: DEFAULT_COLOR,
    expression: DEFAULT_EXPRESSION,
};
/** Human labels for the picker. */
export const SHAPE_LABELS = {
    cercle: "Circle",
    galet: "Pebble",
    squircle: "Squircle",
    capsule: "Capsule",
    triangle: "Triangle",
    hexagone: "Hexagon",
    nuage: "Cloud",
    goutte: "Droplet",
};
export const COLOR_LABELS = {
    encre: "Ink",
    creme: "Cream",
    brun: "Brown",
    rouge: "Red",
    orange: "Orange",
    ambre: "Amber",
    vert: "Green",
    turquoise: "Turquoise",
    bleu: "Blue",
    violet: "Violet",
    rose: "Pink",
    gris: "Grey",
};
export const EXPRESSION_LABELS = {
    neutre: "Neutral",
    attentif: "Attentive",
    surpris: "Surprised",
    excite: "Excited",
    heureux: "Happy",
    hilare: "Laughing",
    colere: "Angry",
    triste: "Sad",
    effraye: "Frightened",
    mefiant: "Wary",
    confus: "Confused",
    curieux: "Curious",
    fier: "Proud",
    timide: "Shy",
    blase: "Bored",
    somnolent: "Sleepy",
};
/** The ids, in the order the picker shows them. */
export const SHAPE_IDS = Object.keys(SHAPE_LABELS);
export const COLOR_IDS = Object.keys(COLOR_LABELS);
export const EXPRESSION_IDS = Object.keys(EXPRESSION_LABELS);
/**
 * Normalises a face coming from anywhere — the API, a stored bot, a form —
 * into one the renderer can draw.
 *
 * An unknown id falls back to the default rather than throwing: the face is
 * cosmetic, and a bot whose face the dashboard cannot draw should still
 * show up. This mirrors the engine's own rule — it accepts any profile and
 * does not depend on its callers' prudence.
 */
export function normalizeFace(raw) {
    const input = (raw ?? {});
    const shape = typeof input.shape === "string" && SHAPE_BY_ID.has(input.shape) ? input.shape : null;
    const color = typeof input.color === "string" && COLOR_BY_ID.has(input.color) ? input.color : null;
    const expression = typeof input.expression === "string" && EXPRESSION_BY_ID.has(input.expression)
        ? input.expression
        : null;
    return {
        shape: shape ?? DEFAULT_FACE.shape,
        color: color ?? DEFAULT_FACE.color,
        expression: expression ?? DEFAULT_FACE.expression,
    };
}
/** True when the face is exactly the default one. */
export function isDefaultFace(face) {
    return (face.shape === DEFAULT_FACE.shape &&
        face.color === DEFAULT_FACE.color &&
        face.expression === DEFAULT_FACE.expression);
}
/**
 * A face nobody chose.
 *
 * The picker is a wall of forty tiles, and someone with no opinion will
 * otherwise leave the default on every bot. The draw is a plain uniform pick
 * per field, which is the honest reading of "surprise": weighting it towards
 * the combinations that happen to look good would keep returning the same
 * faces and stop being a surprise.
 *
 * `rng` is a parameter rather than `Math.random` captured here, so a test can
 * pin the sequence. `avoid` is the face already on screen, because a button
 * that appears to do nothing reads as broken.
 */
export function randomFace(rng = Math.random, avoid) {
    const pick = (ids) => ids[Math.min(ids.length - 1, Math.floor(rng() * ids.length))];
    const face = {
        shape: pick(SHAPE_IDS),
        color: pick(COLOR_IDS),
        expression: pick(EXPRESSION_IDS),
    };
    const same = avoid !== undefined &&
        face.shape === avoid.shape &&
        face.color === avoid.color &&
        face.expression === avoid.expression;
    if (same) {
        // Step the colour instead of redrawing: the shape and the expression are
        // the two choices that read at a glance, so any change beats none.
        const index = COLOR_IDS.indexOf(face.color);
        face.color = COLOR_IDS[(index + 1) % COLOR_IDS.length];
    }
    return face;
}
/** The body colour of a face, as a hex string. */
export function faceInk(face) {
    return COLOR_BY_ID.get(face.color)?.hex ?? "#0a0a0c";
}
/**
 * The plate a face is drawn on.
 *
 * The eyes of the bot are holes punched through its body, so whatever is
 * behind the body is what shows in them. That background therefore has to
 * contrast with the body colour — and the palette holds both a near-black
 * and a near-white, so no single plate works for all twelve.
 *
 * So the plate is the opposite of the body: a light body gets a dark plate,
 * a dark body gets a light one. The two plate colours are absolute, not
 * theme-dependent: a face is a portrait, and a portrait medallion reads the
 * same way in both themes.
 *
 * These mirror `--face-plate-light` and `--face-plate-dark` in styles.css.
 */
export const PLATE_LIGHT = "#f2f3f2";
export const PLATE_DARK = "#0c1116";
/** Relative luminance of a hex colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex) {
    const v = parseInt(hex.replace("#", ""), 16);
    if (!Number.isFinite(v))
        return 0;
    const r = ((v >> 16) & 255) / 255;
    const g = ((v >> 8) & 255) / 255;
    const b = (v & 255) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** The plate colour behind a face, as a CSS value. */
export function facePlate(face) {
    return relativeLuminance(faceInk(face)) > 0.45
        ? "var(--face-plate-dark)"
        : "var(--face-plate-light)";
}
/** The plate colour behind a face, as a hex string (for mixing gradients). */
export function facePlateHex(face) {
    return relativeLuminance(faceInk(face)) > 0.45 ? PLATE_DARK : PLATE_LIGHT;
}
