import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, getSession } from "./api";
import { notifyError } from "./app";
import type { GalleryAsset, Project } from "./types";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  FORM_INPUT,
  FORM_SELECT,
  LoadingState,
  Page,
  PageHeader,
} from "./components";

function isImage(mime: string) {
  return (mime || "").startsWith("image/");
}
function isTextLike(mime: string, name: string) {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  return m.startsWith("text/") || m.includes("json") || m.includes("csv") || m.includes("xml") || m.includes("yaml") || /\.(md|txt|csv|json|ya?ml|log|html?)$/.test(n);
}

function formatBytes(n: number) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 1024 / 102.4) / 10} MB`;
}

function TextPreview({ url }: { url: string; mime?: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url).then((r) => r.text()).then((t) => { if (alive) setText(t.slice(0, 800)); }).catch(() => { if (alive) setText(null); });
    return () => { alive = false; };
  }, [url]);
  if (text == null) return <div className="px-3 text-center text-step--2 text-[var(--faint)]">Preview unavailable</div>;
  return <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words p-2 text-left text-[11px] leading-snug text-[var(--muted)]">{text || "(empty)"}{text.length >= 800 ? "\n…" : ""}</pre>;
}

export function GalleryView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [mime, setMime] = useState("");
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.listProjects().then((r) => {
      setProjects(r.projects || []);
      if (!projectId && r.projects?.[0]?.id) setProjectId(r.projects[0].id);
    }).catch(() => {});
  }, []);

  const load = async () => {
    if (!projectId) { setAssets([]); setTotal(0); return; }
    setLoading(true); setError(null);
    try {
      const res = await api.listGallery(projectId, { q: q || undefined, mime: mime || undefined, limit: 100 });
      setAssets(res.assets || []); setTotal(res.total || 0);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [projectId, q, mime]);

  const upload = async (file: File) => {
    if (!projectId) return;
    setBusy(true);
    try {
      await api.uploadGalleryAsset(projectId, file, { source: file.name });
      toast.success("Asset uploaded");
      await load();
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  };

  const token = getSession()?.token || "";

  return (
    <Page>
      <PageHeader
        eyebrow="Workspace"
        title="Gallery"
        description="Manage images and files for this workspace (view/manage only — no editing, OCR, or transcription). Upload policy: up to 10 MB per asset; stored per-project with metadata and safe previews/thumbnails where supported."
        actions={<>
          <Button variant="primary" onClick={() => fileRef.current?.click()} disabled={!projectId || busy}>Upload file</Button>
          <input ref={fileRef} type="file" className="hidden" aria-label="Upload gallery asset" onChange={(e) => { const f = e.target.files?.[0]; e.target.value=""; if (f) void upload(f); }} />
        </>}
      />
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <Field label="Project">
          <select className={FORM_SELECT} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Select project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.repository || p.id}</option>)}
          </select>
        </Field>
        <Field label="Search">
          <input className={FORM_INPUT} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or source" />
        </Field>
        <Field label="Type filter">
          <select className={FORM_SELECT} value={mime} onChange={(e) => setMime(e.target.value)}>
            <option value="">All types</option>
            <option value="image/">Images</option>
            <option value="text/">Text</option>
            <option value="application/pdf">PDF</option>
          </select>
        </Field>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState error={error} onRetry={() => void load()} /> : assets.length === 0 ? (
        <EmptyState title="No assets" hint="Upload images/files to manage and reference them in docs/chat." />
      ) : (
        <>
          <div className="mb-2 text-step--2 text-[var(--faint)]">{total} assets</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assets.map((a) => {
              const url = api.galleryAssetContentUrl(a.id, token);
              return (
                <div key={a.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                  <div className="mb-2 flex h-40 items-center justify-center overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)]">
                    {isImage(a.mime_type) ? (
                      <img src={url} alt={a.name} className="max-h-full max-w-full object-contain" loading="lazy" />
                    ) : isTextLike(a.mime_type, a.name) && (a.size || 0) <= 512 * 1024 ? (
                      <TextPreview url={url} mime={a.mime_type} />
                    ) : (
                      <div className="px-3 text-center text-step--1 text-[var(--muted)]">
                        <div className="mx-auto mb-1 flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--faint)]" aria-hidden>📄</div>
                        <div className="font-medium text-[var(--text-soft)]">{a.mime_type || "file"}</div>
                        <div className="mt-1 break-all text-step--2">{a.name}</div>
                        <div className="mt-1 text-step--2 text-[var(--faint)]">Safe preview unavailable for this type/size</div>
                      </div>
                    )}
                  </div>
                  <div className="truncate font-medium text-[var(--text)]" title={a.name}>{a.name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-step--2 text-[var(--faint)]">
                    <Badge variant="neutral">{a.mime_type || "unknown"}</Badge>
                    <Badge variant="neutral">{formatBytes(a.size || 0)}</Badge>
                    {(a.metadata as any)?.storage_policy ? <Badge variant="neutral">{String((a.metadata as any).storage_policy)}</Badge> : null}
                  </div>
                  <div className="mt-1 text-step--2 text-[var(--faint)]">Source: {a.source || "—"} · {a.id}</div>
                  {(a.thread_id || a.task_id || a.doc_id) ? <div className="mt-0.5 text-step--2 text-[var(--faint)]">Linked: {a.thread_id ? `thread ${a.thread_id} ` : ""}{a.task_id ? `task ${a.task_id} ` : ""}{a.doc_id ? `doc ${a.doc_id}` : ""}</div> : null}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button onClick={() => window.open(url, "_blank")}>Preview</Button>
                    <Button onClick={() => { const ref = isImage(a.mime_type) ? `![${a.name}](${url})` : `[${a.name}](${url})`; navigator.clipboard?.writeText(ref); toast.success("Markdown reference copied"); }}>Copy md</Button>
                    <Button onClick={() => { navigator.clipboard?.writeText(url); toast.success("Link copied"); }}>Copy link</Button>
                    <Button onClick={() => { navigator.clipboard?.writeText(a.id); toast.success("Asset ID copied"); }}>Copy ID</Button>
                    <Button variant="danger" onClick={async () => { if (!confirm(`Delete ${a.name}?`)) return; try { await api.deleteGalleryAsset(a.id); await load(); } catch(e){notifyError(e);} }}>Delete</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Page>
  );
}
