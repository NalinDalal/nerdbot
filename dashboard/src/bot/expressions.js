import { EYE_H, EYE_SPLIT, EYE_W, REST_GAZE } from "./eyes";
import { lerp } from "./math";
/** `tilt` in degrees, positive = the top of the capsule leans right. */
const eye = (w, h, tilt = 0, open = 1) => ({ w, h, tilt, open });
/** Two identical eyes, with mirrored tilts when `tilt` is given. */
const pair = (w, h, tilt = 0, open = 1) => [
    eye(w, h, tilt, open),
    eye(w, h, -tilt, open),
];
export const EXPRESSIONS = [
    {
        // the pose measured frame by frame on the reference video
        id: "neutre",
        gaze: { ...REST_GAZE },
        split: EYE_SPLIT,
        eyes: [eye(EYE_W, EYE_H), eye(EYE_W, EYE_H)],
    },
    {
        id: "attentif",
        gaze: { yaw: 4, pitch: 5, roll: -4 },
        split: 16,
        eyes: pair(0.21, 0.44),
    },
    {
        id: "surpris",
        gaze: { yaw: 3, pitch: -3, roll: 0 },
        split: 19,
        eyes: pair(0.45, 0.47),
    },
    {
        id: "excite",
        gaze: { yaw: 6, pitch: -14, roll: 0 },
        split: 19.5,
        eyes: pair(0.4, 0.56, -10),
    },
    {
        // eyes narrowed into an arc: the tops converge slightly
        id: "heureux",
        gaze: { yaw: 5, pitch: 9, roll: 0 },
        split: 17,
        eyes: pair(0.27, 0.17, 14),
    },
    {
        id: "hilare",
        gaze: { yaw: 4, pitch: 14, roll: 0 },
        split: 18,
        eyes: pair(0.34, 0.13, 20),
    },
    {
        // tops of the eyes converging hard towards the centre + narrowed eyes
        id: "colere",
        gaze: { yaw: 3, pitch: 7, roll: 0 },
        split: 17,
        eyes: pair(0.34, 0.15, 30),
    },
    {
        // the opposite: tops diverge, and the gaze drops
        id: "triste",
        gaze: { yaw: 3, pitch: -13, roll: 0 },
        split: 16,
        eyes: pair(0.22, 0.4, -28),
    },
    {
        id: "effraye",
        gaze: { yaw: 2, pitch: -20, roll: 0 },
        split: 20.5,
        eyes: pair(0.4, 0.6),
    },
    {
        // one eye clearly more closed than the other
        id: "mefiant",
        gaze: { yaw: 12, pitch: 6, roll: -6 },
        split: 16,
        eyes: [eye(0.21, 0.4), eye(0.22, 0.15)],
    },
    {
        // asymmetric on both axes: sizes AND tilts mismatched. The narrowed eye is
        // deliberately flat (1.6 ratio): at a ratio near 1 it would be round, and
        // its tilt would not be visible.
        id: "confus",
        gaze: { yaw: -14, pitch: 3, roll: 8 },
        split: 16.5,
        eyes: [eye(0.2, 0.44, -18), eye(0.28, 0.17, 14)],
    },
    {
        // the head leans: the roll is what carries the curiosity
        id: "curieux",
        gaze: { yaw: 16, pitch: -9, roll: -15 },
        split: 16.5,
        eyes: [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)],
    },
    {
        id: "fier",
        gaze: { yaw: 5, pitch: 17, roll: 0 },
        split: 17,
        eyes: pair(0.3, 0.15, 18),
    },
    {
        id: "timide",
        gaze: { yaw: -19, pitch: -14, roll: -7 },
        split: 14,
        eyes: pair(0.17, 0.3),
    },
    {
        // horizontal slits, gaze drifting to the side
        id: "blase",
        gaze: { yaw: -22, pitch: 2, roll: 0 },
        split: 16,
        eyes: pair(0.3, 0.12),
    },
    {
        // half-lowered lids: this goes through `open`, so the vertical squash on
        // screen — the same mechanism as a blink
        id: "somnolent",
        gaze: { yaw: 6, pitch: -9, roll: -3 },
        split: 16,
        eyes: pair(0.2, 0.42, 0, 0.42),
    },
];
export const EXPRESSION_BY_ID = new Map(EXPRESSIONS.map((e) => [e.id, e]));
export const DEFAULT_EXPRESSION = "neutre";
const lerpEyeCfg = (a, b, t) => ({
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
    tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t),
    open: lerp(a.open, b.open, t),
});
/** Interpolates two expressions: the change slides rather than jumping. */
export function blendExpression(a, b, t) {
    return {
        id: b.id,
        gaze: {
            yaw: lerp(a.gaze.yaw, b.gaze.yaw, t),
            pitch: lerp(a.gaze.pitch, b.gaze.pitch, t),
            roll: lerp(a.gaze.roll, b.gaze.roll, t),
        },
        split: lerp(a.split, b.split, t),
        eyes: [lerpEyeCfg(a.eyes[0], b.eyes[0], t), lerpEyeCfg(a.eyes[1], b.eyes[1], t)],
    };
}
