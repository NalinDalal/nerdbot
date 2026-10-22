import { useSyncExternalStore } from "react";

/**
 * The one place that knows whether the owner asked for less motion.
 *
 * The stylesheet's `prefers-reduced-motion` block only reaches CSS animations
 * and transitions. The bot avatars are drawn by a `requestAnimationFrame`
 * loop, so they need to be told separately — otherwise a face keeps morphing
 * for someone who has just told their system not to.
 *
 * `useSyncExternalStore` rather than an effect with a state: the preference
 * can change while the page is open, and a subscription is the only way to
 * hear about it without polling.
 */

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function preference(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

/** The preference right now. Outside a browser, motion is allowed. */
export function prefersReducedMotion(): boolean {
  return preference()?.matches ?? false;
}

function subscribe(onChange: () => void): () => void {
  const mq = preference();
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** The preference, kept live for the lifetime of the component. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
