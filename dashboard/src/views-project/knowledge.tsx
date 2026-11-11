import { useState } from "react";
import { api } from "../api";
import { navigate } from "../app";
import { Badge, Button, EmptyState, ErrorState, LoadingState, Modal, PageSection, relativeTime, useAsync } from "../components";
import { EntityForm } from "../forms";

export function KnowledgeTab({ projectId }: { projectId: string }) {
  const sources = useAsync(() => api.listKnowledge(projectId), [projectId]);
  const docs = useAsync(() => api.listLibrary(projectId).catch(() => ({ docs: [] })), [projectId]);
  const gallery = useAsync(() => api.listGallery(projectId, { limit: 8 }).catch(() => ({ assets: [], total: 0 })), [projectId]);
  const [showCreate, setShowCreate] = useState(false);

  const docList = docs.data?.docs ?? [];
  const assets = gallery.data?.assets ?? [];
  const sourceList = sources.data?.sources ?? [];

  return (
    <div className="flex flex-col gap-8">
      <PageSection
        title="Library"
        description="Knowledge, documents, and deliverables for this workspace."
        actions={
          <>
            <Button onClick={() => navigate(`/library`)}>Open global library</Button>
            <Button onClick={() => { sources.reload(); docs.reload(); gallery.reload(); }}>Refresh</Button>
          </>
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-step--1 font-medium text-[var(--text)]">Documents & deliverables</h3>
            </div>
            {docs.loading ? <LoadingState lines={3} /> : docs.error ? <ErrorState error={docs.error} onRetry={docs.reload} /> : docList.length === 0 ? (
              <EmptyState title="No documents yet" hint="Saved documents and outputs from this workspace will appear here." />
            ) : (
              <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg bg-[var(--surface)]">
                {docList.slice(0, 10).map((doc) => (
                  <button key={doc.id} className="flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--surface-2)]" onClick={() => navigate(`/library/${doc.id}`)}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2"><span className="truncate text-step--1 font-medium text-[var(--text)]">{doc.title || "Untitled document"}</span><Badge variant="neutral">{doc.kind || "doc"}</Badge></div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">{doc.format || doc.source || "Document"}{doc.updated_at || doc.created_at ? ` · ${relativeTime((doc.updated_at || doc.created_at) as string)}` : ""}</div>
                    </div>
                    <span className="text-step--2 text-[var(--accent)]">Open</span>
                  </button>
                ))}
              </div>
            )}
            {assets.length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 text-step--1 font-medium text-[var(--text)]">Recent assets</div>
                <div className="flex flex-col gap-1.5">
                  {assets.slice(0, 5).map((a) => (
                    <button key={a.id} className="flex items-center justify-between rounded-md bg-[var(--surface)] px-3 py-2 text-left text-step--1 hover:bg-[var(--surface-2)]" onClick={() => navigate("/gallery")}> 
                      <span className="truncate text-[var(--text)]">{a.name || "Asset"}</span>
                      <span className="text-step--2 text-[var(--muted)]">{a.mime_type || "file"}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-6">
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-step--1 font-medium text-[var(--text)]">Knowledge sources</h3>
                <Button variant="primary" onClick={() => setShowCreate(true)}>Add source</Button>
              </div>
              {showCreate ? (
                <Modal title="Add knowledge source" onClose={() => setShowCreate(false)}>
                  <EntityForm
                    submitLabel="Save"
                    fields={[
                      { name: "title", label: "Title", required: true },
                      { name: "content", label: "Content", required: true, type: "textarea" },
                      { name: "source", label: "Source (provenance)", required: true, placeholder: "ops-wiki" },
                    ]}
                    onSubmit={async (values) => {
                      await api.ingestKnowledge(projectId, values);
                      setShowCreate(false);
                      sources.reload();
                    }}
                  />
                </Modal>
              ) : null}
              {sources.loading ? <LoadingState lines={3} /> : sources.error ? <ErrorState error={sources.error} onRetry={sources.reload} /> : sourceList.length === 0 ? (
                <EmptyState title="No knowledge sources" hint="Add notes and context with provenance for this workspace." />
              ) : (
                <div className="flex flex-col divide-y divide-[var(--border-dim)] rounded-lg bg-[var(--surface)]">
                  {sourceList.map((source) => (
                    <div key={source.id} className="px-4 py-3">
                      <div className="text-step--1 font-medium text-[var(--text)]">{source.title}</div>
                      <div className="mt-0.5 text-step--2 text-[var(--muted)]">Source: {source.source}</div>
                      <div className="mt-1 line-clamp-2 text-step--2 text-[var(--text-soft)]">{source.content}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg bg-[var(--surface)] px-4 py-3">
              <div className="text-step--1 font-medium text-[var(--text)]">Files & workspace outputs</div>
              <p className="mt-1 text-step--2 text-[var(--muted)]">Task checkouts and produced files are available in Files & tools.</p>
              <div className="mt-3"><Button onClick={() => navigate(`/p/${projectId}?tab=Files`)}>Open files & tools</Button></div>
            </div>
          </div>
        </div>
      </PageSection>
    </div>
  );
}
