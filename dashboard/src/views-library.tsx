import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, getSession } from "./api";
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

export function filterLibraryDocs<T extends { doc: LibraryDoc }>(
  rows: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(({ doc }) =>
    [doc.title, doc.source, doc.content, doc.format || "", doc.kind || ""].some((value) =>
      (value || "").toLowerCase().includes(needle),
    ),
  );
}

export function libraryProvenance(
  doc: LibraryDoc,
  mateName: (teammateId: string) => string,
): string {
  const writer = doc.teammate_id ? mateName(doc.teammate_id) : "you";
  return doc.tainted
    ? `Last written by ${writer} — bot-written, review before trusting`
    : `Last written by ${writer}`;
}

export function libraryKindLabel(kind: string): string {
  if (kind === "upload") return "Upload";
  if (kind === "doc") return "Document";
  return "Note";
}

function sanitizeHtml(html: string): string {
  // Simple sanitizer for preview: strip scripts/event handlers/javascript URLs.
  return (html || "")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|\')\s*javascript:[^"']*(\2)/gi, '$1="#"')
    .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "");
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const s = text || "";
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { inQuotes = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    cell += ch; i++;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) rows.push(row);
  return rows;
}

function toCsv(rows: string[][]): string {
  const esc = (v: string) => {
    const s = v ?? "";
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

function CsvGrid({ value, onChange, readOnly }: { value: string; onChange?: (v: string) => void; readOnly?: boolean }) {
  const [rows, setRows] = useState<string[][]>(() => parseCsv(value || ""));
  useEffect(() => { setRows(parseCsv(value || "")); }, [value]);
  const update = (next: string[][]) => {
    setRows(next);
    onChange?.(toCsv(next));
  };
  return (
    <div className="overflow-auto rounded-lg border border-[var(--border)]">
      <table className="min-w-full border-collapse text-step--1">
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci} className="border border-[var(--border-dim)] p-0">
                  <input
                    className="w-full min-w-[120px] bg-transparent px-2 py-1 outline-none"
                    value={c}
                    readOnly={readOnly}
                    onChange={(e) => {
                      const next = rows.map((row) => [...row]);
                      next[ri][ci] = e.target.value;
                      update(next);
                    }}
                    aria-label={`Row ${ri + 1} column ${ci + 1}`}
                  />
                </td>
              ))}
              {!readOnly ? (
                <td className="border border-[var(--border-dim)] px-1">
                  <button type="button" className="text-[var(--danger)]" title="Delete row" onClick={() => update(rows.filter((_, i) => i !== ri))}>×</button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly ? (
        <div className="flex gap-2 border-t border-[var(--border-dim)] p-2">
          <Button onClick={() => update([...rows, Array(Math.max(1, rows[0]?.length || 1)).fill("")])}>Add row</Button>
          <Button onClick={() => update(rows.map((r) => [...r, ""]))}>Add column</Button>
        </div>
      ) : null}
    </div>
  );
}

/* --- list ------------------------------------------------------------------ */

export function LibraryView() {
  const [query, setQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const view = useAsync(async () => {
    const projects = await api.listProjects();
    const perProject = await Promise.all(
      projects.projects.map(async (project: Project) => {
        try {
          const { docs } = await api.listLibrary(project.id);
          return docs.map((doc) => ({ doc, projectName: project.repository || "Untitled" }));
        } catch {
          return [];
        }
      }),
    );
    return perProject.flat().sort((a, b) => (a.doc.updated_at < b.doc.updated_at ? 1 : -1));
  }, []);

  const rows = filterLibraryDocs(view.data ?? [], query).filter(({ doc }) => !formatFilter || (doc.format || "md") === formatFilter);

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Library"
        description="Living documents and artifacts (markdown, HTML, CSV, text) with version history, exports, and AI-assisted editing."
        actions={
          <>
            <Button variant="primary" onClick={() => setShowNew(true)}>New document</Button>
            <Button onClick={() => fileInputRef.current?.click()}>Upload file</Button>
          </>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt,.markdown,.csv,.json,.yml,.yaml,.html,.htm,text/*"
        className="hidden"
        aria-label="Upload a text file to the Library"
        onChange={(e) => {
          const file = e.target.files?.[0] ?? null;
          e.target.value = "";
          if (file) setUploadFile(file);
        }}
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search documents"
          aria-label="Search documents"
          className="h-9 w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-step--1 outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]"
        />
        <select className={FORM_SELECT} value={formatFilter} onChange={(e) => setFormatFilter(e.target.value)} aria-label="Format filter">
          <option value="">All formats</option>
          <option value="md">Markdown</option>
          <option value="csv">CSV</option>
          <option value="html">HTML</option>
          <option value="text">Text</option>
        </select>
      </div>

      {view.loading ? (
        <LoadingState />
      ) : view.error ? (
        <ErrorState error={view.error} onRetry={view.reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={query || formatFilter ? "No documents match" : "No documents yet"}
          hint={query || formatFilter ? "Try a different search/filter." : "Create a doc, upload a text file, or save content from chat/research."}
          action={!query && !formatFilter ? <Button variant="primary" onClick={() => setShowNew(true)}>New document</Button> : null}
        />
      ) : (
        <div className={TABLE_SHELL}>
          <table className="w-full min-w-[700px] table-fixed">
            <thead>
              <tr>
                <th className={`${TABLE_TH} w-[38%]`}>Document</th>
                <th className={`${TABLE_TH} w-[20%]`}>Project</th>
                <th className={`${TABLE_TH} w-[6rem]`}>Format</th>
                <th className={`${TABLE_TH} w-[7rem]`}>Kind</th>
                <th className={`${TABLE_TH} w-[9rem]`}>Updated</th>
                <th className={`${TABLE_TH} w-[6rem]`}><span className="sr-only">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ doc, projectName }) => (
                <tr key={doc.id} className="transition-colors hover:bg-[var(--surface-2)]">
                  <td className={TABLE_TD}>
                    <button className="flex items-center gap-2 text-left text-[var(--text)] hover:underline" onClick={() => navigate(`/library/${doc.id}`)}>
                      <span className="truncate">{doc.title || "Untitled"}</span>
                      {doc.tainted ? <Badge variant="warn">bot-written</Badge> : null}
                    </button>
                  </td>
                  <td className={`${TABLE_TD} truncate text-[var(--muted)]`}>{projectName}</td>
                  <td className={TABLE_TD}><Badge variant="neutral">{(doc.format || "md").toUpperCase()}</Badge></td>
                  <td className={TABLE_TD}><Badge variant="neutral">{libraryKindLabel(doc.kind)}</Badge></td>
                  <td className={`${TABLE_TD} whitespace-nowrap text-[var(--faint)]`}>{relativeTime(doc.updated_at)}</td>
                  <td className={`${TABLE_TD} whitespace-nowrap`}><Button variant="ghost" onClick={() => navigate(`/library/${doc.id}`)}>Open →</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew || uploadFile ? (
        <NewDocModal initialFile={uploadFile} onClose={() => { setShowNew(false); setUploadFile(null); }} />
      ) : null}
    </Page>
  );
}

function NewDocModal({ initialFile, onClose }: { initialFile: File | null; onClose: () => void }) {
  const projects = useAsync(() => api.listProjects(), []);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState(initialFile ? initialFile.name : "");
  const [content, setContent] = useState("");
  const [format, setFormat] = useState("md");
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
      const doc = await api.createLibraryDoc(chosen, { title: title.trim(), content, kind: "note", format, source: "manual" });
      toast.success("Document created");
      onClose();
      navigate(`/library/${doc.id}`);
    } catch (err) {
      notifyError(err);
    } finally { setBusy(false); }
  };

  return (
    <Modal title={isUpload ? "Upload to Library" : "New document"} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="flex flex-col gap-1">
        <Field label="Project">
          <select value={chosen} onChange={(e) => setProjectId(e.target.value)} className={FORM_SELECT} disabled={projects.loading}>
            {projectList.map((p) => <option key={p.id} value={p.id}>{p.repository || "Untitled"}</option>)}
          </select>
        </Field>
        <Field label="Title">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isUpload ? initialFile?.name : "Document title"} className={FORM_INPUT} required={!isUpload} />
        </Field>
        {isUpload ? (
          <p className="mb-3 text-step--1 text-[var(--muted)]">{initialFile?.name} — text file, up to 1 MiB.</p>
        ) : (
          <>
            <Field label="Format">
              <select value={format} onChange={(e) => setFormat(e.target.value)} className={FORM_SELECT}>
                <option value="md">Markdown</option>
                <option value="csv">CSV</option>
                <option value="html">HTML</option>
                <option value="text">Text</option>
              </select>
            </Field>
            <Field label="Content">
              <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} placeholder={format === "csv" ? "a,b\n1,2" : "Start writing…"} className={`${FORM_INPUT} resize-y`} />
            </Field>
          </>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !chosen}>{isUpload ? "Upload" : "Create"}</Button>
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
    () => doc.data ? api.listTeammates(doc.data.project_id) : Promise.resolve({ teammates: [] as Teammate[] }),
    [docId, doc.data?.project_id],
  );

  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftFormat, setDraftFormat] = useState("md");
  const [baseVersion, setBaseVersion] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [autosave, setAutosave] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const [grantMate, setGrantMate] = useState("");
  const [grantLevel, setGrantLevel] = useState<"read" | "write">("read");
  const [aiInstr, setAiInstr] = useState("");
  const [suggestion, setSuggestion] = useState<{ suggested_content: string; diff: string; attribution?: any } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const token = getSession()?.token || "";

  const teammateList = mates.data?.teammates ?? [];
  const mateName = (teammateId: string) => {
    const mate = teammateList.find((m) => m.id === teammateId);
    return mate ? mate.name || mate.slug || mate.id : "a teammate";
  };

  useEffect(() => {
    if (doc.data && !editing) {
      setDraftTitle(doc.data.title || "");
      setDraftContent(doc.data.content || "");
      setDraftFormat(doc.data.format || "md");
      setBaseVersion(doc.data.version || 1);
    }
  }, [doc.data, editing]);

  const reloadAll = () => { doc.reload(); versions.reload(); access.reload(); };

  const doSave = async (opts?: { silent?: boolean; expected?: number }) => {
    if (!doc.data) return;
    if (!opts?.silent) setBusy(true);
    setAutosave("saving");
    try {
      const updated = await api.patchLibraryDoc(docId, {
        title: draftTitle,
        content: draftContent,
        format: draftFormat,
        expected_version: opts?.expected ?? baseVersion,
      });
      setBaseVersion(updated.version);
      setAutosave("saved");
      if (!opts?.silent) { toast.success("Saved"); setEditing(false); }
      await doc.reload();
      await versions.reload();
    } catch (err: any) {
      const conflict = err?.status === 409 || err?.detail?.conflict || (typeof err?.detail === "object" && err?.detail?.conflict);
      if (conflict) {
        setAutosave("conflict");
        if (!opts?.silent) toast.error("Save conflict: document changed elsewhere. Reload and retry.");
      } else {
        setAutosave("error");
        if (!opts?.silent) notifyError(err);
      }
    } finally {
      if (!opts?.silent) setBusy(false);
    }
  };

  useEffect(() => {
    if (!editing || !doc.data) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void doSave({ silent: true, expected: baseVersion }); }, 1200);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftTitle, draftContent, draftFormat, editing]);

  const startEdit = () => {
    if (!doc.data) return;
    setDraftTitle(doc.data.title || "");
    setDraftContent(doc.data.content || "");
    setDraftFormat(doc.data.format || "md");
    setBaseVersion(doc.data.version || 1);
    setEditing(true);
    setAutosave("idle");
    setSuggestion(null);
  };

  const restore = async (version: number) => {
    if (!confirm(`Restore version ${version}? Current content becomes a new version.`)) return;
    setBusy(true);
    try {
      await api.restoreLibraryVersion(docId, version);
      toast.success(`Version ${version} restored`);
      setEditing(false); setSuggestion(null);
      reloadAll();
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  };

  const grant = async () => {
    if (!grantMate) return;
    try { await api.setLibraryAccess(docId, grantMate, grantLevel); setGrantMate(""); access.reload(); toast.success("Access updated"); }
    catch (err) { notifyError(err); }
  };
  const revoke = async (teammateId: string) => {
    try { await api.revokeLibraryAccess(docId, teammateId); access.reload(); toast.success("Access removed"); }
    catch (err) { notifyError(err); }
  };
  const remove = async () => {
    if (!doc.data) return;
    if (!confirm(`Delete "${doc.data.title || "Untitled"}" and its entire history?`)) return;
    try { await api.deleteLibraryDoc(docId); toast.success("Document deleted"); navigate("/library"); }
    catch (err) { notifyError(err); }
  };

  const askAi = async () => {
    if (!aiInstr.trim()) return;
    setBusy(true);
    try {
      const res = await api.aiSuggestLibraryDoc(docId, aiInstr.trim());
      setSuggestion({ suggested_content: res.suggested_content, diff: res.diff, attribution: res.attribution });
      toast.success("Suggestion ready (not applied)");
    } catch (err) { notifyError(err); } finally { setBusy(false); }
  };

  if (doc.loading) return <Page><LoadingState /></Page>;
  if (doc.error || !doc.data) return <Page><ErrorState error={doc.error ?? new Error("Document not found")} onRetry={doc.reload} /></Page>;

  const current = doc.data;
  const aclRows = access.data?.access ?? [];
  const grantedIds = new Set(aclRows.map((row) => row.teammate_id));
  const grantable = teammateList.filter((m) => !grantedIds.has(m.id));
  const exportUrl = (fmt: string) => api.exportLibraryDocUrl(docId, fmt, token);

  return (
    <Page width="reading">
      <PageHeader
        back={{ label: "Library", onClick: () => navigate("/library") }}
        eyebrow={`${libraryKindLabel(current.kind)} · ${(current.format || "md").toUpperCase()}`}
        title={current.title || "Untitled"}
        description={libraryProvenance(current, mateName)}
        actions={editing ? (
          <>
            <Button variant="ghost" onClick={() => { setEditing(false); setSuggestion(null); setAutosave("idle"); }} disabled={busy}>Cancel</Button>
            <Button variant="primary" onClick={() => void doSave({ expected: baseVersion })} disabled={busy}>Save</Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={startEdit}>Edit</Button>
            <Button variant="danger" onClick={() => void remove()}>Delete</Button>
          </>
        )}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {current.tainted ? <Badge variant="warn">bot-written</Badge> : null}
        <Badge variant="neutral">v{current.version}</Badge>
        <Badge variant="neutral">{(current.format || "md").toUpperCase()}</Badge>
        {current.source ? <span className="text-step--2 text-[var(--faint)]">source: {current.source}</span> : null}
        <span className="text-step--2 text-[var(--faint)]">updated {relativeTime(current.updated_at)}</span>
        {editing ? <span className="text-step--2 text-[var(--faint)]">autosave: {autosave}{autosave === "conflict" ? " (reload to resolve)" : ""}</span> : null}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <a className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 hover:bg-[var(--surface-2)]" href={exportUrl("md")} target="_blank" rel="noreferrer">Export .md</a>
        <a className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 hover:bg-[var(--surface-2)]" href={exportUrl("csv")} target="_blank" rel="noreferrer">Export .csv</a>
        <a className="inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 hover:bg-[var(--surface-2)]" href={exportUrl("html")} target="_blank" rel="noreferrer">Export .html</a>
        {(current.thread_id || current.task_id || current.job_id) ? (
          <span className="text-step--2 text-[var(--faint)] self-center">Linked: {current.thread_id ? `thread ${current.thread_id} ` : ""}{current.task_id ? `task ${current.task_id} ` : ""}{current.job_id ? `job ${current.job_id}` : ""}</span>
        ) : null}
      </div>

      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Title"><input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} className={FORM_INPUT} /></Field>
            <Field label="Format">
              <select value={draftFormat} onChange={(e) => setDraftFormat(e.target.value)} className={FORM_SELECT}>
                <option value="md">Markdown</option><option value="csv">CSV</option><option value="html">HTML</option><option value="text">Text</option>
              </select>
            </Field>
          </div>
          {draftFormat === "csv" ? (
            <Field label="Content (CSV grid)"><CsvGrid value={draftContent} onChange={setDraftContent} /></Field>
          ) : (
            <Field label="Content"><textarea value={draftContent} onChange={(e) => setDraftContent(e.target.value)} rows={18} className={`${FORM_INPUT} resize-y font-mono`} /></Field>
          )}
          {draftFormat === "html" ? (
            <div>
              <div className="mb-1 text-step--2 font-medium text-[var(--muted)]">Sanitized preview</div>
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeHtml(draftContent) }} />
            </div>
          ) : null}

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="mb-2 text-step--1 font-medium text-[var(--text)]">Ask AI (suggested revision — not applied automatically)</div>
            <div className="flex flex-wrap gap-2">
              <input className={`${FORM_INPUT} min-w-[260px] flex-1`} value={aiInstr} onChange={(e) => setAiInstr(e.target.value)} placeholder="e.g. tighten intro, fix tone, summarize, convert to table..." />
              <Button onClick={() => void askAi()} disabled={busy || !aiInstr.trim()}>Generate suggestion</Button>
            </div>
            {suggestion ? (
              <div className="mt-3 space-y-2">
                <div className="text-step--2 text-[var(--muted)]">Attribution: {suggestion.attribution?.actor_type || "assistant"} {suggestion.attribution?.actor || ""}. Review before applying.</div>
                {suggestion.diff ? <pre className="max-h-56 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] p-2 text-step--2 whitespace-pre-wrap">{suggestion.diff}</pre> : null}
                <details className="rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] p-2">
                  <summary className="cursor-pointer text-step--2 font-medium">Suggested content preview</summary>
                  <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-step--2">{suggestion.suggested_content}</pre>
                </details>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => { setDraftContent(suggestion.suggested_content); setSuggestion(null); toast.success("Suggestion applied to draft (save to persist)"); }}>Accept/apply to draft</Button>
                  <Button onClick={() => setSuggestion(null)}>Reject</Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {(current.format || "md") === "csv" ? (
            <CsvGrid value={current.content || ""} readOnly />
          ) : (current.format || "md") === "html" ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
              <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: sanitizeHtml(current.content || "") }} />
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
              {current.content ? <Markdown text={current.content} /> : <p className="text-step--1 text-[var(--faint)]">This document is empty.</p>}
            </div>
          )}
        </div>
      )}

      <div className="mt-10">
        <PageSection title="Version history" description="Every save is kept. Restoring adds a new version instead of erasing one.">
          {versions.loading ? <LoadingState lines={2} /> : versions.error ? <ErrorState error={versions.error} onRetry={versions.reload} /> : (versions.data?.versions.length ?? 0) === 0 ? (
            <EmptyState title="No versions yet" hint="" />
          ) : (
            <div className={TABLE_SHELL}>
              <table className="w-full min-w-[560px] table-fixed">
                <thead><tr><th className={`${TABLE_TH} w-[6rem]`}>Version</th><th className={TABLE_TH}>When</th><th className={TABLE_TH}>Writer</th><th className={`${TABLE_TH} w-[8rem]`}><span className="sr-only">Restore</span></th></tr></thead>
                <tbody>
                  {[...(versions.data?.versions ?? [])].reverse().map((v: LibraryDocVersion) => (
                    <tr key={v.id}>
                      <td className={TABLE_TD}>v{v.version}{v.version === current.version ? <span className="ml-1 text-[var(--faint)]">(current)</span> : null}</td>
                      <td className={`${TABLE_TD} text-[var(--faint)]`}>{relativeTime(v.created_at)}</td>
                      <td className={TABLE_TD}>{v.teammate_id ? mateName(v.teammate_id) : "you"}{v.tainted ? " · bot-written" : ""}</td>
                      <td className={TABLE_TD}>{v.version === current.version ? null : <Button variant="ghost" onClick={() => void restore(v.version)} disabled={busy}>Restore</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PageSection>
      </div>

      <div className="mt-10">
        <PageSection title="Access" description="Who can read or edit this document. Owner manages access; a missing row means no access.">
          {access.loading ? <LoadingState lines={2} /> : access.error ? <ErrorState error={access.error} onRetry={access.reload} /> : (
            <>
              <div className={TABLE_SHELL}>
                <table className="w-full min-w-[520px] table-fixed">
                  <thead><tr><th className={TABLE_TH}>Teammate</th><th className={`${TABLE_TH} w-[8rem]`}>Access</th><th className={`${TABLE_TH} w-[8rem]`}><span className="sr-only">Revoke</span></th></tr></thead>
                  <tbody>
                    {aclRows.length === 0 ? (
                      <tr><td className={`${TABLE_TD} text-[var(--faint)]`} colSpan={3}>No teammate has access yet.</td></tr>
                    ) : aclRows.map((row: LibraryDocAccess) => (
                      <tr key={row.id}>
                        <td className={TABLE_TD}>{mateName(row.teammate_id)}</td>
                        <td className={TABLE_TD}><Badge variant={row.access === "write" ? "ok" : "neutral"}>{row.access}</Badge></td>
                        <td className={TABLE_TD}><Button variant="ghost" onClick={() => void revoke(row.teammate_id)}>Remove</Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="Teammate">
                  <select value={grantMate} onChange={(e) => setGrantMate(e.target.value)} className={FORM_SELECT}>
                    <option value="">Choose a teammate</option>
                    {grantable.map((m) => <option key={m.id} value={m.id}>{m.name || m.slug || m.id}</option>)}
                  </select>
                </Field>
                <Field label="Access">
                  <select value={grantLevel} onChange={(e) => setGrantLevel(e.target.value as "read" | "write")} className={FORM_SELECT}>
                    <option value="read">Read</option><option value="write">Write</option>
                  </select>
                </Field>
                <div className="pb-3"><Button variant="primary" onClick={() => void grant()} disabled={!grantMate}>Grant access</Button></div>
              </div>
            </>
          )}
        </PageSection>
      </div>
    </Page>
  );
}
