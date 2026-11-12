export function partKind(part) {
    if (part?.type === "report")
        return "report";
    if (part?.type === "task")
        return "task";
    return "unknown";
}
export function isTaskProposal(part) {
    return part?.type === "task" && !!part?.proposal && !part?.task_id;
}


export function executionStages(task, run) {
  const status = String((task && task.status) || "pending");
  const runStatus = String((run && run.status) || "");
  const assigned = !!(task && task.owner_teammate_id);
  const running = status === "running" || runStatus === "running";
  const needsReview = status === "awaiting_approval" || status === "blocked";
  const failed = status === "failed" || runStatus === "failed";
  const done = status === "done" || status === "completed" || runStatus === "completed";
  return [
    { label: "Task created", state: "done", detail: "Queued in workspace" },
    { label: "Agent assigned", state: assigned ? "done" : "pending", detail: assigned ? "Owner assigned" : "Waiting for assignment" },
    { label: "Execution", state: failed ? "error" : running ? "active" : done || needsReview ? "done" : assigned ? "pending" : "pending", detail: failed ? "Execution failed" : running ? "In progress" : done ? "Execution completed" : "Not started yet" },
    { label: "Review", state: needsReview ? "warn" : done ? "done" : "pending", detail: needsReview ? ((task && task.blocked_reason) || "Awaiting approval or decision") : done ? "No blocking review" : "Not required yet" },
    { label: "Results", state: done ? "done" : failed ? "error" : "pending", detail: done ? "Completed (open task for outputs)" : failed ? "No successful result yet" : "Not available yet" },
  ];
}
