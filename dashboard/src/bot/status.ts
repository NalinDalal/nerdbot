import type { StateId } from "./states";

/**
 * What a bot's face does for a given status.
 *
 * The engine ships fifteen states and the dashboard used one of them: every
 * bot breathed at idle whether it was working, waiting on the owner, blocked
 * or done. The status was carried by a small coloured dot, which is a footnote
 * rather than a face.
 *
 * The mapping is deliberately coarse. A pose is read at a glance and at
 * twenty-eight pixels, so the question it answers is "does this thing want
 * something from me?", not "which of nine failure kinds is this?". Where two
 * statuses would produce near-identical poses — `blocked` and `failed` both
 * become `alert` — one pose is better than two that differ by a nuance nobody
 * will see. The status badge keeps the word.
 *
 * `done` is a moment rather than a state, so nothing derives it from history:
 * a bot that finished an hour ago rests. It is here for the surfaces that
 * show one completed thing.
 */
export function faceStateFor(status?: string | null): StateId {
  switch (status) {
    // Working: the body turns into a spinning triangle.
    case "running":
      return "orbit";

    // Waiting to start, or ready to: the body becomes three dots.
    case "queued":
    case "pending":
    case "ready":
      return "thinking";

    // The owner is the blocker. A pip, because the next move is theirs.
    case "awaiting_approval":
      return "notify";

    // Stopped on something, or something went wrong. One pose: the body
    // becomes an exclamation mark, which is unambiguous at any size.
    case "blocked":
    case "failed":
    case "denied":
    case "rejected":
    case "expired":
    case "error":
      return "alert";

    // Finished: the ball with one eye closed. A nod, not a celebration.
    case "done":
    case "succeeded":
      return "wink";

    // Off. The body shrinks to a dot that breathes, which is a dot when it
    // is frozen and a slow pulse when it is not.
    case "disabled":
    case "archived":
    case "cancelled":
    case "stopped":
      return "sleep";

    // `active`, a missing status, and anything the catalogue does not know:
    // the resting face. An unknown status is not a reason to stop breathing.
    default:
      return "idle";
  }
}

/** The shape of the two records `botActivity` reads. */
interface HasStatus {
  status: string;
}

/**
 * What a bot is doing right now, derived from its work rather than its own
 * column.
 *
 * A teammate's own `status` says whether it is enabled — `active` — and never
 * says that it is busy, so the bot's page cannot show "working" from it. Its
 * tasks can. The order is the order of who is blocking whom: an unanswered
 * approval is the owner's move, so it outranks everything; then work in
 * flight; then something stopped; then a queue.
 *
 * Only durable signals are used. A run's history contains every failure the
 * bot ever had, and reading that would leave a bot looking alarmed forever,
 * so failures are read from the tasks — which are what a human retries.
 */
export function botActivity(
  status: string,
  tasks: ReadonlyArray<HasStatus>,
  runs: ReadonlyArray<HasStatus> = [],
): string {
  if (tasks.some((t) => t.status === "awaiting_approval")) return "awaiting_approval";
  if (tasks.some((t) => t.status === "running") || runs.some((r) => r.status === "running")) {
    return "running";
  }
  if (tasks.some((t) => t.status === "blocked")) return "blocked";
  // The two waiting states are kept apart so the dot says the same word as
  // the badge beside it: `pending` is still waiting for its turn, `ready` is
  // waiting for an executor to pick it up.
  if (tasks.some((t) => t.status === "pending")) return "queued";
  if (tasks.some((t) => t.status === "ready")) return "ready";
  return status;
}
