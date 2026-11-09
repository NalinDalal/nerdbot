export type ChatPart = { type?: string; [key: string]: any };

export function partKind(part: ChatPart): "report" | "task" | "unknown" {
  if (part?.type === "report") return "report";
  if (part?.type === "task") return "task";
  return "unknown";
}

export function isTaskProposal(part: ChatPart): boolean {
  return part?.type === "task" && !!part?.proposal && !part?.task_id;
}
