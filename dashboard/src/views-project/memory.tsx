import { useState } from "react";
import { api } from "../api";
import { Button, CARD_SHELL, EmptyState, ErrorState, LoadingState, Modal, useAsync } from "../components";
import { EntityForm } from "../forms";
export function MemoryTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.projectMemory(projectId), [projectId]);
  const [showWrite, setShowWrite] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowWrite(true)}>
          Write memory
        </Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>
      {showWrite ? (
        <Modal title="Write memory" onClose={() => setShowWrite(false)}>
          <EntityForm
            submitLabel="Store"
            fields={[
              { name: "content", label: "Content", required: true, type: "textarea" },
              { name: "source", label: "Source (provenance)", required: true },
              { name: "confidence", label: "Confidence (0–1)", placeholder: "0.8" },
            ]}
            onSubmit={async (values) => {
              await api.writeProjectMemory(projectId, {
                ...values,
                confidence: Number(values.confidence || 0.5),
              });
              setShowWrite(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.entries.length > 0 ? (
        list.data.entries.map((entry) => (
          <div className={CARD_SHELL} key={entry.id}>
            <div>{entry.content}</div>
            <div className="text-[var(--muted)]" style={{ fontSize: 12, marginTop: 4 }}>
              {entry.source} · confidence {entry.confidence} ·{" "}
              <span className="mono">{entry.id}</span>
            </div>
          </div>
        ))
      ) : (
        <EmptyState title="No memories" hint="Project-scoped memories with provenance live here." />
      )}
    </div>
  );
}
