# 0010 — A Bot's Face Is the Owner's Choice, and It Lives in the Dashboard

Date: 2026-10-22. Status: accepted and implemented.

## Context

NerdBot's bots were drawn: a small blob whose colour and shape came from a
hash of the bot id, so a fleet was scannable by face alone. The face was
therefore the product's own invention, and it looked like a placeholder —
a rounded square with two white ellipses.

The owner of a personal workspace has a say in what their bots look like.
The shape of a bot's face is not authority and not execution: it changes
nothing about what the bot may do, what it can read, or what it costs. It
is a **presentation** choice, and it is the owner's.

The drawing itself is not ours to write. [bloub](https://github.com/jeremy-prt/bloub)
(MIT, jeremy-prt) is an SVG recreation of the x.ai bot avatar: one filled
shape morphing through fourteen states, two white shapes for the eyes that
morph independently, every constant measured off the reference video frame
by frame. It ships eight body shapes, twelve colours and sixteen resting
expressions, which is exactly the set of choices a face needs.

## Options considered

**(a) Keep the drawn blob and let the owner pick a colour from it.** Rejected.

The blob has no face to speak of: two ellipses that never move, never
blink, never look anywhere. Colouring it does not make it a character, it
makes it a coloured blob.

**(b) Write our own avatar.** Rejected.

The hard part of an avatar is not the drawing, it is the *behaviour*: the
eyes living on a sphere so they compress and tilt with the head's
orientation, the blink being a vertical squash in screen space rather than
a narrowing along the capsule's axis, the gaze drift being a pure function
of time so pausing and resuming give the same image. bloub has all of it,
measured rather than guessed, and it is MIT licensed. Writing our own would
mean writing a worse version of the same thing.

**(c) Port bloub, and let the owner choose the face.** Adopted.

The engine is ported to TypeScript and to React, in `dashboard/src/bot/`.
The upstream `src/bot/` is framework-free and clock-free — `engine.sample(t)`
is a pure function of time — so the port is the geometry, not a rewrite.

## The decision

**The face is three ids: a body shape, a colour and a resting expression.**
The owner chooses them in the "Face" step of the create-bot wizard, and can
change them afterwards from the bot's own page.

**The dashboard owns the geometry; the server owns the vocabulary.** The
shape, the colour and the expression are drawn in the browser, so their
geometry lives in `dashboard/src/bot/`. The server keeps the list of valid
ids in `nerdbot/faces.py` so the API can refuse a face nobody can draw
instead of storing it and letting the dashboard silently substitute the
default. The two lists are checked against each other by
`tests/test_bot_faces.py`, which reads the dashboard's TypeScript source: a
shape added on one side and forgotten on the other fails the build rather
than the product.

**A face is not authority.** It is not a permission, it is not gated, and
it rides along with the rest of a teammate update — including an update
made by a bot about itself, which is why `update_teammate` accepts it as an
ordinary field.

**An unknown id is a 400, not a stored value.** A face is three ids or it
is nothing: a partial face is refused rather than half-defaulted, because
the stored value would otherwise depend on which fields the caller happened
to send. A face the catalogue no longer knows reads back as the default,
so a bot is never left without a face to draw.

**The face is drawn on a plate.** The eyes of the bot are holes punched
through its body, so whatever is behind the body shows in them — and the
palette holds both a near-black and a near-white body, so no single
background works for all twelve colours. The plate is therefore the
opposite of the body: a light body gets a dark plate, a dark body a light
one. The plate colours are absolute rather than theme-dependent, because a
face is a portrait and a portrait medallion reads the same way in both
themes.

**Small faces do not animate.** A fleet page can hold twenty avatars, and
twenty animation loops are a page that janks. The faces in lists draw a
single frame; the ones that carry the page — the bot's own page, the
picker's preview — run the loop. The still is posed to the bot's status, so a
frozen face still says what the bot is doing; see
[0013](0013-bot-motion.md).

## Consequences

- The dashboard grew a `src/bot/` folder that is a port, not original work.
  `src/bot/README.md` says what came from where, and what changed in the
  port: the comments are in English, and the table of eye offsets is built
  lazily instead of at import time, because three hundred entries of
  geometric search at module load is a price a dashboard should not pay.
- The upstream test suite came with it. `src/bot/faces.test.ts` is
  upstream's `skins.test.ts`, ported: it measures the rendered geometry, and
  it is what caught a transcription error in the port.
- The face is stored as a JSON column on `teammates`, next to the other
  JSON columns, and it travels in backups like them.
