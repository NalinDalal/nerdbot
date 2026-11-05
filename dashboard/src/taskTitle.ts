/** Derive a short title from a task description. */
export function taskTitle(description: string): string {
  const lines = (description || "").split(/\r?\n/);
  let first = "";
  for (const line of lines) {
    const cleaned = line.trim().replace(/^[\s#*-]+/, "").replace(/\s+/g, " ").trim();
    if (cleaned) { first = cleaned; break; }
  }
  if (!first) return "";
  if (first.length > 80) return first.slice(0, 79) + "…";
  return first;
}


/** Return the next ~100 chars after the title. */
export function taskPreview(description: string): string {
  const title = taskTitle(description);
  const rest = (description || "").slice(title.length).trim();
  return rest.slice(0, 100);
}
