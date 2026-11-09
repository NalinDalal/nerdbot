import { useEffect, useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import type { MemoryEntry } from "../types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  FORM_INPUT,
  FORM_SELECT,
  LoadingState,
  Modal,
  useAsync,
} from "../components";
import { EntityForm } from "../forms";

export function MemoryTab({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const [tier, setTier] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const limit = 30;
  const list = useAsync(
    () => api.projectMemory(projectId, { q: q || undefined, tier: tier || undefined, pinned: pinnedOnly || undefined, limit, offset: page * limit }),
    [projectId, q, tier, pinnedOnly, page],
  );
  const [showWrite, setShowWrite] = useState(false);
  const [edit, setEdit] = useState<MemoryEntry | null>(null);

  useEffect(() => { setPage(0); }, [q, tier, pinnedOnly]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); list.reload(); } catch (err) { notifyError(err); }
  };

  const entries = list.data?.entries ?? [];
  const total = list.data?.total ?? entries.length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setShowWrite(true)}>Remember something</Button>
        <Button onClick={list.reload}>Refresh</Button>
        <Button variant="ghost" onClick={() => void act(() => api.pruneMemory(`project:${projectId}`, { keep: 500 }))}>Retention prune</Button>
        <input className={`${FORM_INPUT} max-w-xs`} placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
        <select className={FORM_SELECT} value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier filter">
          <option value="">All tiers</option>
          <option value="raw">raw</option>
          <option value="typed">typed</option>
          <option value="wisdom">wisdom</option>
        </select>
        <label className="flex items-center gap-1.5 text-step--1 text-[var(--muted)]">
          <input type="checkbox" checked={pinnedOnly} onChange={(e) => setPinnedOnly(e.target.checked)} /> Pinned
        </label>
      </div>

      <p className="mb-3 text-step--1 text-[var(--muted)]">
        What this workspace remembers, with source/provenance. Memories are scoped and fail-closed. When chat uses memories, it treats them as untrusted context.
      </p>

      {showWrite ? (
        <Modal title="Add memory" onClose={() => setShowWrite(false)}>
          <EntityForm
            submitLabel="Save"
            fields={[
              { name: "content", label: "What to remember", required: true, type: "textarea" },
              { name: "source", label: "Source/provenance", required: true, placeholder: "e.g. user note, chat summary" },
              { name: "confidence", label: "Confidence (0–1)", placeholder: "0.8" },
              { name: "tier", label: "Tier", placeholder: "raw|typed|wisdom" },
            ]}
            onSubmit={async (values) => {
              await api.writeProjectMemory(projectId, {
                content: values.content,
                source: values.source,
                confidence: Number(values.confidence || 0.8),
                tier: (values.tier as string) || "raw",
                provenance: { kind: "manual", actor: "user" },
              });
              setShowWrite(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}

      {edit ? (
        <Modal title="Edit memory" onClose={() => setEdit(null)}>
          <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); try { await api.patchMemory(edit.id, { content: (e.currentTarget as any).content.value, source: (e.currentTarget as any).source.value }); setEdit(null); list.reload(); } catch (err) { notifyError(err); } }}>
            <label className="text-step--1"><div className="mb-1 font-medium">Content</div><textarea name="content" className={`${FORM_INPUT} min-h-24`} defaultValue={edit.content} /></label>
            <label className="text-step--1"><div className="mb-1 font-medium">Source</div><input name="source" className={FORM_INPUT} defaultValue={edit.source} /></label>
            <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" type="submit">Save correction</Button></div>
          </form>
        </Modal>
      ) : null}

      {list.loading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : entries.length === 0 ? (
        <EmptyState title="No memories yet" hint="Add a note, or let the workspace accumulate scoped memories. Search, pin important facts, correct mistakes, or delete entries here." />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 whitespace-pre-wrap text-step--1 text-[var(--text-soft)]">{entry.content}</div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {entry.pinned ? <Badge variant="info">pinned</Badge> : null}
                    {entry.corrected ? <Badge variant="warn">corrected</Badge> : null}
                    <Badge variant="neutral">{entry.tier || "raw"}</Badge>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-step--2 text-[var(--faint)]">
                  <span>Source: <span className="text-[var(--muted)]">{entry.source || "unknown"}</span></span>
                  <span>Confidence: {typeof entry.confidence === "number" ? entry.confidence.toFixed(2) : entry.confidence}</span>
                  <span>Scope: <span className="mono">{entry.scope}</span></span>
                  <span className="mono">{entry.id}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button onClick={() => void act(() => api.patchMemory(entry.id, { pinned: !entry.pinned }))}>{entry.pinned ? "Unpin" : "Pin"}</Button>
                  <Button onClick={() => setEdit(entry)}>Correct</Button>
                  <Button variant="danger" onClick={() => { if (confirm("Delete this memory?")) void act(() => api.deleteMemory(entry.id)); }}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between text-step--2 text-[var(--muted)]">
            <span>{total} total</span>
            <div className="flex gap-2">
              <Button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
              <Button disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
