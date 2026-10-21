import { useState } from "react";
import { api } from "../api";
import { Button, CARD_SHELL, EmptyState, ErrorState, LoadingState, Modal, useAsync } from "../components";
import { EntityForm } from "../forms";
export function KnowledgeTab({ projectId }: { projectId: string }) {
  const list = useAsync(() => api.listKnowledge(projectId), [projectId]);
  const [showCreate, setShowCreate] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          Ingest knowledge
        </Button>
        <Button onClick={list.reload}>Refresh</Button>
      </div>
      {showCreate ? (
        <Modal title="Ingest knowledge" onClose={() => setShowCreate(false)}>
          <EntityForm
            submitLabel="Ingest"
            fields={[
              { name: "title", label: "Title", required: true },
              { name: "content", label: "Content", required: true, type: "textarea" },
              { name: "source", label: "Source (provenance)", required: true, placeholder: "ops-wiki" },
            ]}
            onSubmit={async (values) => {
              await api.ingestKnowledge(projectId, values);
              setShowCreate(false);
              list.reload();
            }}
          />
        </Modal>
      ) : null}
      {list.loading ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.sources.length > 0 ? (
        list.data.sources.map((source) => (
          <div className={CARD_SHELL} key={source.id}>
            <strong>{source.title}</strong> <span className="text-[var(--muted)]">· {source.source}</span>
            <div className="mono text-[var(--muted)]">{source.id}</div>
          </div>
        ))
      ) : (
        <EmptyState title="No knowledge sources" hint="Ingest runbooks and notes with provenance." />
      )}
    </div>
  );
}
