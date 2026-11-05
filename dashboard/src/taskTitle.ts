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
