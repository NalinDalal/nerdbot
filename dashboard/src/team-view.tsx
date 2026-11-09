import { useEffect, useState } from "react";
import { api } from "./api";
import { BotFace } from "./components";

export function deriveMemberState(member: any): "idle" | "working" | "waiting_approval" | "failed" {
  if (member?.current?.status === "running") return "working";
  if ((member?.failed || 0) > 0) return "failed";
  if (member?.current?.status === "pending") return "waiting_approval";
  return "idle";
}

export function TeamView({ objectiveId, onOpenTask }: { objectiveId: string; onOpenTask?: (pid: string, tid: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!objectiveId) return;
    let alive = true;
    const load = async () => {
      try {
        const d = await (api as any).teamActivity?.(objectiveId);
        if (alive) setData(d);
      } catch (e: any) {
        if (alive) setError(e?.message || "failed to load");
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [objectiveId]);

  if (!objectiveId) return null;
  if (error) return <div className="text-step--1 text-[var(--danger)]">{error}</div>;
  if (!data) return <div className="text-step--1 text-[var(--muted)]">Loading team…</div>;

  const obj = data.objective || {};
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-step-0 font-semibold text-[var(--text)]">{obj.title || "Objective"}</div>
        <div className="text-step--2 text-[var(--muted)]">
          {obj.done ?? 0} of {obj.total ?? 0} done · {obj.status}
        </div>
      </div>
      {(data.members || []).some((m: any) => !m.teammate?.provider_id) ? (
        <div className="rounded-md border border-[var(--warn)] bg-[var(--warn-dim)] px-2.5 py-2 text-step--2 text-[var(--warn)]">
          Some teammates have no model configured. Attach a provider in Settings.
        </div>
      ) : null}
      {(data.members || []).map((m: any, i: number) => {
        const state = deriveMemberState(m);
        return (
          <div key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2">
            <div className="flex items-center gap-2">
              <BotFace face={m.teammate?.face} size={24} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-step--1 text-[var(--text)]">{m.teammate?.name || m.teammate?.slug}</div>
                <div className="truncate text-step--2 text-[var(--muted)]">
                  {state === "idle" && "Idle"}
                  {state === "working" && (m.current?.title || "Working…")}
                  {state === "waiting_approval" && "Waiting for approval"}
                  {state === "failed" && "Failed"}
                </div>
              </div>
            </div>
            {m.current?.task_id ? (
              <button type="button" className="mt-1 text-step--2 text-[var(--accent)] hover:underline" onClick={() => onOpenTask?.("", m.current.task_id)}>
                Open task →
              </button>
            ) : null}
          </div>
        );
      })}
      {(data.failures || []).length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-step--2 font-medium uppercase tracking-wider text-[var(--danger)]">Failures</div>
          {data.failures.map((f: any, i: number) => (
            <div key={i} className="rounded-md border border-[var(--danger)] bg-[var(--danger-dim)] px-2.5 py-2 text-step--1 text-[var(--danger)]">
              {f.title || f.task_id}: {f.reason_text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
