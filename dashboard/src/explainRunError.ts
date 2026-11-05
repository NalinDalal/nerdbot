/**
 * What a failed run's error text means to the owner.
 *
 * Most errors mean themselves. Exactly one does not: the executor raises a
 * bare "empty command" when a task has neither a shell command nor a model
 * to run on, which reads like a syntax problem but is really a missing
 * setup step. For that one case the error is translated into a sentence
 * plus links to the two tabs that fix it; everything else passes through
 * unchanged, unedited, and no invented explanation.
 *
 * NOTE: this whole thing is a stopgap. Matching the error by its string
 * toils until the backend sets a blocked_reason for this case — once one
 * arrives, the translation moves server-side and this file shrinks to a
 * pass-through.
 */

/** The exact error string the executor raises when it has no command and
 *  no model to answer with. See the module note: string match = stopgap. */
const EMPTY_COMMAND_ERROR = "empty command";

/** Shape of {@link explainRunError}'s result: one message, zero or more
 *  actions. `actions` is empty for an unknown error and for no error. */
export interface RunErrorExplanation {
  /** The text to show, already trimmed. "" when the run recorded nothing. */
  message: string;
  /** Places that fix the cause, in the order they should be tried. */
  actions: Array<{ label: string; href: string }>;
}

/** The error text a failed run carries: stderr first, then the output
 *  excerpt — the executor writes the one meaningful string to whichever is
 *  filled, so either may hold it. */
function runErrorText(run: { stderr: string; output_excerpt: string }): string {
  return run.stderr.trim() || run.output_excerpt.trim();
}

/**
 * Explain a failed run in words the owner can act on.
 *
 * @param task - The task the run belongs to; its command decides whether an
 *   "empty command" error is the missing-model case, and its `project_id`
 *   targets the action links.
 * @param run - The failed run; its stderr / output excerpt is the evidence.
 * @returns The message to show plus fix-it links. Unknown error texts pass
 *   through as `message` with no actions; a run with no error text yields
 *   an empty message so callers can show nothing at all.
 */
export function explainRunError(
  task: { command: string; project_id: string },
  run: { stderr: string; output_excerpt: string },
): RunErrorExplanation {
  const errorText = runErrorText(run);
  if (!errorText) return { message: "", actions: [] };
  if (errorText === EMPTY_COMMAND_ERROR && !task.command.trim()) {
    return {
      message:
        "Nothing ran: this task has no command and no model is attached. Attach a model to the owner, or set a command.",
      actions: [
        { label: "Open the Teammates tab", href: `/p/${task.project_id}?tab=Teammates` },
        { label: "Open the Providers tab", href: `/p/${task.project_id}?tab=Providers` },
      ],
    };
  }
  return { message: errorText, actions: [] };
}
