# 0013 — The Face Tells the Truth, and Motion Is Consented To

Date: 2026-10-22. Status: accepted and implemented.

## Context

[0010](0010-bot-faces.md) gave every bot a face the owner picks — a body
shape, a colour and a resting expression — drawn by a port of bloub. It left
three things open, and one defect:

1. **The loop ignored reduced motion.** `styles.css` has a
   `prefers-reduced-motion` block, but it only reaches CSS animations and
   transitions. The avatar is an SVG driven by `requestAnimationFrame`, so
   someone who has asked their system for less motion still got a
   continuously morphing face on the bot page, in the picker, and in the
   previews. The gap is ours: upstream has no such handling either.
2. **The loop was per avatar.** One `requestAnimationFrame` each. Two is
   comfortable; it was the ceiling, and it was the reason lists were kept
   still.
3. **There was no randomise control.** The picker is eight bodies by twelve
   colours by sixteen expressions. Someone with no opinion had to make three
   decisions, or leave the default on every bot — so a fleet looked identical.
4. **The face said nothing about the bot.** The engine ships fifteen states
   and the dashboard used one: everything breathed at idle. Whether a bot was
   working, waiting on the owner, blocked or done was carried by a seven-pixel
   dot.

## The decision

**Reduced motion is read in JavaScript, and animated becomes static.** The
preference is the owner's, and an avatar is decoration: a decoration is never
a reason to overrule it. `src/motion.ts` is the only place that asks
(`useReducedMotion`, over `useSyncExternalStore`, so a change mid-session is
heard). `BotAvatar` gates on `animated && !reduced`. The still frame is the
same composition the static path already drew — not a missing face and not a
frozen first frame.

Pointer-follow is motion too, so it is gated on the same condition.

**One loop for every face on the page.** `src/bot/ticker.ts` owns a single
`requestAnimationFrame`, a single clock, and a set of subscribers. The clock
step is capped at 64 ms (`MAX_DT`, the number the component used when it owned
its clock): a hidden tab's frames are suspended, and stepping by the real gap
would throw a face minutes forward on the way back. The loop cancels itself
when the last face leaves and restarts with no step on the next join, so the
clock resumes where it stopped.

The scheduler is injected rather than imported. That is what makes the loop
testable a frame at a time without a browser.

**A face is posed to the bot's real status.** `src/bot/status.ts` maps a
status to one of the ported states:

| status | pose | why |
| --- | --- | --- |
| `running` | `orbit` | a spinning body reads as work |
| `queued`, `pending`, `ready` | `thinking` | three dots: waiting to start |
| `awaiting_approval` | `notify` | a pip, because the next move is the owner's |
| `blocked`, `failed`, `denied`, `rejected`, `expired`, `error` | `alert` | an exclamation, unambiguous at any size |
| `done`, `succeeded` | `wink` | a nod, not a celebration |
| `disabled`, `archived`, `cancelled`, `stopped` | `sleep` | the body shrinks to a dot that breathes |
| `active`, missing, unknown | `idle` | the resting face |

The mapping is deliberately coarse: a pose is read at a glance and at
twenty-eight pixels, so the question is "does this want something from me?",
not "which of nine failure kinds is this?". Where two statuses would produce
near-identical poses, one pose is better than two nobody can tell apart; the
badge keeps the word.

**The bot page derives activity from work, not from its own column.** A
teammate's `status` says whether it is enabled and never says it is busy, so
`botActivity` reads the tasks (and only a *running* run). The order is the
order of who is blocking whom: an unanswered approval first, then work in
flight, then blocked, then a queue. Run **history** is not read for failure —
it holds every failure the bot ever had, and reading it would leave a bot
looking alarmed forever. Tasks are read because a human retries those.

**Lists stay static, but the still is posed.** A face frozen mid-`orbit` still
reads as working. That is the win: the state travels to every surface, and
only the bot's own page and the picker pay for animation.

**A random face is a uniform draw.** `randomFace(rng, avoid)` picks one id per
field, with the source injectable so tests can pin it. Pressing it on the face
already on screen moves the colour at least one step: a surprise that changes
nothing reads as a broken button.

## Consequences

- Nothing new is drawn. Every pose in the table is one of the fifteen the
  engine already shipped and `faces.test.ts` already measures.
- More surfaces animate is now affordable, but nothing was switched on: the
  list faces remain static by design, and the loop only runs for the faces
  that ask for it.
- The status vocabulary is the server's, not the dashboard's. A status added
  later falls back to `idle` until it earns a pose — which is the safe side of
  the mapping, not the noise side.
- `ticker.ts` and `status.ts` are ours, not ported; `src/bot/README.md` says
  which files came from where.
