export type TaskCardState = "proposed" | "queued" | "running" | "done" | "failed";

export function deriveTaskCardState(task: any, latestRun: any): { state: TaskCardState; reason?: string } {
  if (!task) return { state: "proposed" };
  if (task.status === "done") return { state: "done" };
  if (task.status === "failed" || latestRun?.status === "failed") {
    return { state: "failed", reason: latestRun?.stderr || latestRun?.output_excerpt || "Run failed." };
  }
  if (latestRun?.status === "running" || task.status === "running") return { state: "running" };
  return { state: "queued" };
}
