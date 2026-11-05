/** One description line, cleaned for display: markdown decorations off the
 *  front, separator punctuation off the end, internal whitespace
 *  collapsed. taskTitle and taskPreview both run lines through this so the
 *  two can never disagree about what a line "is". */
function cleanTitleLine(line: string): string {
  return line
    .trim()
    .replace(/^[\s#*-]+/, "")
    .replace(/[\s:\-#—]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Derive a short title from a task description. */
export function taskTitle(description: string): string {
  const lines = (description || "").split(/\r?\n/);
  let first = "";
  for (const line of lines) {
    const cleaned = cleanTitleLine(line);
    if (cleaned) { first = cleaned; break; }
  }
  if (!first) return "";
  if (first.length > 80) return first.slice(0, 79) + "…";
  return first;
}

/** Return the next ~100 chars after the title: the first line after any
 *  separator rows (drawn from only "=", "-", "#", "*", whitespace) that is
 *  not the title line itself, cleaned of markdown markers like taskTitle. */
export function taskPreview(description: string): string {
  const title = taskTitle(description);
  const lines = (description || "").split(/\r?\n/);
  let rest = "";
  for (const line of lines) {
    const cleaned = cleanTitleLine(line);
    if (!cleaned) continue;
    if (/^[=\-*#\s]+$/.test(line.trim())) continue;
    if (cleaned === title) continue;
    rest = cleaned;
    break;
  }
  return rest.length > 100 ? `${rest.slice(0, 99)}…` : rest;
}
