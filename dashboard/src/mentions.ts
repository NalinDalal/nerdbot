/** @mention helpers shared by the chat composer and the message renderer.
 *
 *  The handle grammar mirrors the backend's MENTION_RE in
 *  ``nerdbot/chat.py``: an @ followed by letters, digits, underscore or
 *  hyphen. Keeping both sides identical is what makes a picker-inserted
 *  mention and a highlighted one resolve to the same teammate.
 */

const MENTION_SPLIT_RE = /(@[A-Za-z0-9][A-Za-z0-9_-]{0,63})/g;

/** A handle must be one bare token or the backend's mention regex would
 *  stop early ("@Personal Assistant" would only ever address "Personal"). */
const VALID_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The handle the picker inserts for a teammate: slug first, then a
 *  one-word name, then the id (which is always a valid handle). */
export function mentionHandle(teammate: { slug?: string; name?: string; id: string }): string {
  if (teammate.slug && VALID_HANDLE_RE.test(teammate.slug)) return teammate.slug;
  if (teammate.name && VALID_HANDLE_RE.test(teammate.name)) return teammate.name;
  return teammate.id;
}

/** Insert ``@handle`` at the caret-less end of the draft, keeping exactly
 *  one space between the existing text and the new mention. */
export function insertMention(draft: string, handle: string): string {
  const trimmed = draft.replace(/\s*$/, "");
  return trimmed ? `${trimmed} @${handle} ` : `@${handle} `;
}

/** Split text into plain and mention segments, in order. */
export function splitMentions(text: string): Array<{ text: string; mention: boolean }> {
  return text
    .split(MENTION_SPLIT_RE)
    .filter((chunk) => chunk !== "")
    .map((chunk) => ({ text: chunk, mention: chunk.startsWith("@") }));
}
