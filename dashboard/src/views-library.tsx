import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { navigate, notifyError } from "./app";
import { Markdown } from "./markdown";
import type { LibraryDoc, LibraryDocAccess, LibraryDocVersion, Project, Teammate } from "./types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  FORM_INPUT,
  FORM_SELECT,
  LoadingState,
  Modal,
  Page,
  PageHeader,
  PageSection,
  TABLE_SHELL,
  TABLE_TD,
  TABLE_TH,
  relativeTime,
  useAsync,
} from "./components";

/* --- pure helpers (unit-tested) ------------------------------------------- */

/** Search a document by title, source or content, case-insensitively. */
export function filterLibraryDocs<T extends { doc: LibraryDoc }>(
  rows: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(({ doc }) =>
    [doc.title, doc.source, doc.content].some((value) =>
      (value || "").toLowerCase().includes(needle),
    ),
  );
}

/** The one line that says who last wrote this and whether a bot touched it. */
export function libraryProvenance(
  doc: LibraryDoc,
  mateName: (teammateId: string) => string,
): string {
  const writer = doc.teammate_id ? mateName(doc.teammate_id) : "you";
  return doc.tainted
    ? `Last written by ${writer} — bot-written, review before trusting`
    : `Last written by ${writer}`;
}

/** Short label for a document kind. */
export function libraryKindLabel(kind: string): string {
  if (kind === "upload") return "Upload";
  if (kind === "doc") return "Document";
  return "Note";
}

/* --- list ------------------------------------------------------------------ */

export function LibraryView() {
  const [query, setQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* The Library spans every project the owner has: one list, newest save
     first, with the project named so a document is never ambiguous. */
  const view = useAsync(async () => {
    const projects = await api.listProjects();
    const perProject = await Promise.all(
      projects.projects.map(async (project: Project) => {
        try {
          const { docs } = await api.listLibrary(project.id);
          return docs.map((doc) => ({ doc, projectName: project.repository || "Untitled" }));
        } catch {
          return []; // one unreadable project must not blank the Library
        }
      }),
    );
    return perProject
      .flat()
      .sort((a, b) => (a.doc.updated_at < b.doc.updated_at ? 1 : -1));
  }, []);

  const rows = filterLibraryDocs(view.data ?? [], query);

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Library"
        description="Your notes, documents and uploaded text — with full history and per-bot access."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowNew(true)}>
              New note
            </Button>
            <Button onClick={() => fileInputRef.current?.click()}>Upload file</Button>
          </>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt,.markdown,.csv,.json,.yml,.yaml,text/*"
        className="hidden"
        aria-label="Upload a text file to the Library"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.target.value = "";
          if (file) setUploadFile(file);
        }}
      />

      <div className="mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search documents"
          aria-label="Search documents"
          className="h-9 w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-step--1 outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
        />
      </div>

      {view.loading ? (
        <LoadingState />
      ) : view.error ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={query ? "No documents match" : "No documents yet"}
          hint={
            query
              ? "Try a different word — search covers titles and content."
              : "Write a note or upload a text file; every save keeps its history."
          }
          action={
            query ? null : (
              <Button variant="primary" onClick={() => setShowNew(true)}>
                New note
              </Button>
            )
          }
        />
      ) : (
        <div className={TABLE_SHELL}>
          <table className="w-full min-w-[640px] table-fixed">
            <thead>
              <tr>
                <th className={`${TABLE_TH} w-[40%]`}>Document</th>
                <th className={`${TABLE_TH} w-[22%]`}>Project</th>
                <th className={`${TABLE_TH} w-[7rem]`}>Kind</th>
                <th className={`${TABLE_TH} w-[9rem]`}>Updated</th>
                <th className={`${TABLE_TH} w-[6rem]`}>
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ doc, projectName }) => (
                <tr key={doc.id} className="transition-colors hover:bg-[var(--surface-2)]">
                  <td className={TABLE_TD}>
                    <button
                      className="flex items-center gap-2 text-left text-[var(--text)] hover:underline"
                      onClick={() => navigate(`/library/${doc.id}`)}
                    >
                      <span className="truncate">{doc.title || "Untitled"}</span>
                      {doc.tainted ? <Badge variant="warn">bot-written</Badge> : null}
                    </button>
                  </td>
                  <td className={`${TABLE_TD} truncate text-[var(--muted)]`}>{projectName}</td>
                  <td className={TABLE_TD}>
                    <Badge variant="neutral">{libraryKindLabel(doc.kind)}</Badge>
                  </td>
                  <td className={`${TABLE_TD} whitespace-nowrap text-[var(--faint)]`}>
                    {relativeTime(doc.updated_at)}
                  </td>
                  <td className={`${TABLE_TD} whitespace-nowrap`}>
                    <Button variant="ghost" onClick={() => navigate(`/library/${doc.id}`)}>
                      Open →
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew || uploadFile ? (
        <NewDocModal
          initialFile={uploadFile}
          onClose={() => {
            setShowNew(false);
            setUploadFile(null);
          }}
        />
      ) : null}
    </Page>
  );
}

/* --- create / upload ------------------------------------------------------- */

function NewDocModal({
  initialFile,
  onClose,
}: {
  initialFile: File | null;
  onClose: () => void;
}) {
  const projects = useAsync(() => api.listProjects(), []);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState(initialFile ? initialFile.name : "");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  const projectList = projects.data?.projects ?? [];
  const chosen = projectId || projectList[0]?.id || "";
  const isUpload = initialFile !== null;

  const submit = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      if (isUpload && initialFile) {
        const text = await initialFile.text();
        const doc = await api.uploadLibraryDoc(chosen, initialFile.name, text);
        toast.success(`Uploaded ${initialFile.name}`);
        onClose();
        navigate(`/library/${doc.id}`);
        return;
      }
      if (!title.trim()) return;
      const doc = await api.createLibraryDoc(chosen, {
        title: title.trim(),
        content,
        kind: "note",
      });
      toast.success("Note created");
      onClose();
      navigate(`/library/${doc.id}`);
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={isUpload ? "Upload to Library" : "New note"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-1"
      >
        <Field label="Project">
          <select
            value={chosen}
            onChange={(e) => setProjectId(e.target.value)}
            className={FORM_SELECT}
            disabled={projects.loading}
          >
            {projectList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.repository || "Untitled"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={isUpload ? initialFile?.name : "Meeting notes"}
            className={FORM_INPUT}
            required={!isUpload}
          />
        </Field>
        {isUpload ? (
          <p className="mb-3 text-step--1 text-[var(--muted)]">
            {initialFile?.name} — text file, up to 1&nbsp;MiB. It is stored as a
            document you can edit later.
          </p>
        ) : (
          <Field label="Content">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              placeholder="Markdown is welcome."
              className={`${FORM_INPUT} resize-y`}
            />
          </Field>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !chosen}>
            {isUpload ? "Upload" : "Create note"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* --- detail ---------------------------------------------------------------- */

export function LibraryDocView({ docId }: { docId: string }) {
  const doc = useAsync(() => api.getLibraryDoc(docId), [docId]);
  const versions = useAsync(() => api.listLibraryVersions(docId), [docId]);
  const access = useAsync(() => api.listLibraryAccess(docId), [docId]);
  const mates = useAsync(
    () =>
      doc.data
        ? api.listTeammates(doc.data.project_id)
        : Promise.resolve({ teammates: [] as Teammate[] }),
    [docId, doc.data?.project_id],
  );

  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [grantMate, setGrantMate] = useState("");
  const [grantLevel, setGrantLevel] = useState<"read" | "write">("read");

  const teammateList = mates.data?.teammates ?? [];
  const mateName = (teammateId: string) => {
    const mate = teammateList.find((m) => m.id === teammateId);
    return mate ? mate.name || mate.slug || mate.id : "a teammate";
  };

  const reloadAll = () => {
    doc.reload();
    versions.reload();
    access.reload();
  };

  const startEdit = () => {
    if (!doc.data) return;
    setDraftTitle(doc.data.title);
    setDraftContent(doc.data.content);
    setEditing(true);
  };

  const save = async () => {
    if (!doc.data || busy) return;
    setBusy(true);
    try {
      await api.patchLibraryDoc(docId, {
        title: draftTitle,
        content: draftContent,
      });
      toast.success("Saved");
      setEditing(false);
      reloadAll();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: number) => {
    if (!confirm(`Restore version ${version}? The current text becomes a new version, so nothing is lost.`)) return;
    setBusy(true);
    try {
      await api.restoreLibraryVersion(docId, version);
      toast.success(`Version ${version} restored`);
      setEditing(false);
      reloadAll();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };

  const grant = async () => {
    if (!grantMate) return;
    try {
      await api.setLibraryAccess(docId, grantMate, grantLevel);
      setGrantMate("");
      access.reload();
      toast.success("Access updated");
    } catch (err) {
      notifyError(err);
    }
  };

  const revoke = async (teammateId: string) => {
    try {
      await api.revokeLibraryAccess(docId, teammateId);
      access.reload();
      toast.success("Access removed");
    } catch (err) {
      notifyError(err);
    }
  };

  const remove = async () => {
    if (!doc.data) return;
    if (!confirm(`Delete "${doc.data.title || "Untitled"}" and its entire history?`)) return;
    try {
      await api.deleteLibraryDoc(docId);
      toast.success("Document deleted");
      navigate("/library");
    } catch (err) {
      notifyError(err);
    }
  };

  if (doc.loading) {
    return (
      <Page>
        <LoadingState />
      </Page>
    );
  }
  if (doc.error || !doc.data) {
    return (
      <Page>
        <ErrorState error={doc.error ?? new Error("Document not found")} onRetry={doc.reload} />
      </Page>
    );
  }

  const current = doc.data;
  const aclRows = access.data?.access ?? [];
  const grantedIds = new Set(aclRows.map((row) => row.teammate_id));
  const grantable = teammateList.filter((m) => !grantedIds.has(m.id));

  return (
    <Page width="reading">
      <PageHeader
        back={{ label: "Library", onClick: () => navigate("/library") }}
        eyebrow={libraryKindLabel(current.kind)}
        title={current.title || "Untitled"}
        description={libraryProvenance(current, mateName)}
        actions={
          editing ? (
            <>
              <Button variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={busy}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={startEdit}>
                Edit
              </Button>
              <Button variant="danger" onClick={() => void remove()}>
                Delete
              </Button>
            </>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {current.tainted ? <Badge variant="warn">bot-written</Badge> : null}
        <Badge variant="neutral">v{current.version}</Badge>
        {current.source ? (
          <span className="text-step--2 text-[var(--faint)]">source: {current.source}</span>
        ) : null}
        <span className="text-step--2 text-[var(--faint)]">
          updated {relativeTime(current.updated_at)}
        </span>
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <Field label="Title">
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className={FORM_INPUT}
            />
          </Field>
          <Field label="Content">
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={16}
              className={`${FORM_INPUT} resize-y font-mono`}
            />
          </Field>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
          {current.content ? (
            <Markdown text={current.content} />
          ) : (
            <p className="text-step--1 text-[var(--faint)]">This document is empty.</p>
          )}
        </div>
      )}

      <div className="mt-10">
        <PageSection
          title="Version history"
          description="Every save is kept. Restoring adds a new version instead of erasing one."
        >
          {versions.loading ? (
            <LoadingState lines={2} />
          ) : versions.error ? (
            <ErrorState error={versions.error} onRetry={versions.reload} />
          ) : (versions.data?.versions.length ?? 0) === 0 ? (
            <EmptyState title="No history yet" hint="Saves appear here as versions." />
          ) : (
            <ul className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {[...(versions.data?.versions ?? [])].reverse().map((v: LibraryDocVersion, index: number) => (
                <li
                  key={v.id}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 ${
                    index > 0 ? "border-t border-[var(--border-dim)]" : ""
                  }`}
                >
                  <span className="mono w-12 shrink-0 text-step--1 text-[var(--text)]">
                    v{v.version}
                  </span>
                  <span className="text-step--1 text-[var(--faint)]">
                    {relativeTime(v.created_at)}
                  </span>
                  <span className="text-step--1 text-[var(--muted)]">
                    by {v.teammate_id ? mateName(v.teammate_id) : "you"}
                  </span>
                  {v.tainted ? <Badge variant="warn">bot-written</Badge> : null}
                  <span className="ml-auto">
                    {v.version === current.version ? (
                      <span className="text-step--2 text-[var(--faint)]">current</span>
                    ) : (
                      <Button variant="ghost" onClick={() => void restore(v.version)} disabled={busy}>
                        Restore
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PageSection>

        <PageSection
          title="Who can open this"
          description="Teammates need an explicit row here — and their knowledge permission — before they can read or write."
        >
          {access.loading ? (
            <LoadingState lines={2} />
          ) : access.error ? (
            <ErrorState error={access.error} onRetry={access.reload} />
          ) : (
            <>
              {aclRows.length === 0 ? (
                <p className="mb-3 text-step--1 text-[var(--muted)]">
                  Only you can open this document.
                </p>
              ) : (
                <ul className="mb-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
                  {aclRows.map((row: LibraryDocAccess, index: number) => (
                    <li
                      key={row.id}
                      className={`flex flex-wrap items-center gap-3 px-4 py-2.5 ${
                        index > 0 ? "border-t border-[var(--border-dim)]" : ""
                      }`}
                    >
                      <span className="text-step--1 text-[var(--text)]">
                        {mateName(row.teammate_id)}
                      </span>
                      <Badge variant={row.access === "write" ? "info" : "neutral"}>
                        {row.access}
                      </Badge>
                      <span className="ml-auto">
                        <Button variant="ghost" onClick={() => void revoke(row.teammate_id)}>
                          Revoke
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {grantable.length > 0 ? (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Teammate">
                    <select
                      value={grantMate}
                      onChange={(e) => setGrantMate(e.target.value)}
                      className={`${FORM_SELECT} min-w-[14rem]`}
                    >
                      <option value="">Choose a teammate…</option>
                      {grantable.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name || m.slug || m.id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Access">
                    <select
                      value={grantLevel}
                      onChange={(e) => setGrantLevel(e.target.value as "read" | "write")}
                      className={FORM_SELECT}
                    >
                      <option value="read">Read</option>
                      <option value="write">Write</option>
                    </select>
                  </Field>
                  <Button variant="primary" onClick={() => void grant()} disabled={!grantMate}>
                    Grant
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </PageSection>
      </div>
    </Page>
  );
}
