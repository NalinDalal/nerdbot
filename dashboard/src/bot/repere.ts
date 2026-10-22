/**
 * The reference frame of everything the engine renders.
 *
 * `engine.sample()` returns coordinates in viewBox units, and these two
 * numbers define those units. They live here because `src/bot/` is the part
 * that is read and consumed from the outside: the React component is ONE
 * client of the engine, not its definition.
 */

/**
 * Radius of the resting ball, in viewBox units. This is the `scale` handed to
 * `BotEngine`.
 *
 * Chosen, not measured: it is the unit of work. Everything else in the
 * folder is expressed as a fraction of this radius, which keeps the
 * measurements taken off the reference video independent of display size.
 */
export const RAYON = 100;

/**
 * Half-width of the viewBox. The margin past the radius holds the orbit
 * rings.
 *
 * Not a free value: the orbit rings and the comet swoosh reach 1.4 times the
 * radius, i.e. 140. Nothing bounds that at runtime — it is the hand-tuned
 * `RINGS` and `SWOOSH` tables in `decor.ts` that keep them under 158.
 */
export const DEMI_VIEWBOX = 158;

/**
 * Half-width of a viewBox cropped to the body only. Used by the small
 * avatars, where the rings would only shrink the face.
 */
export const DEMI_CORPS = 112;
