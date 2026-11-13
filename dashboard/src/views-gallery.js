import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, getSession } from "./api";
import { notifyError } from "./app";
import { Badge, Button, EmptyState, ErrorState, Field, FORM_INPUT, FORM_SELECT, LoadingState, Page, PageHeader, } from "./components";
function isImage(mime) {
    return (mime || "").startsWith("image/");
}
function isTextLike(mime, name) {
    const m = (mime || "").toLowerCase();
    const n = (name || "").toLowerCase();
    return m.startsWith("text/") || m.includes("json") || m.includes("csv") || m.includes("xml") || m.includes("yaml") || /\.(md|txt|csv|json|ya?ml|log|html?)$/.test(n);
}
function formatBytes(n) {
    if (!n)
        return "0 B";
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${Math.round(n / 102.4) / 10} KB`;
    return `${Math.round(n / 1024 / 102.4) / 10} MB`;
}
function TextPreview({ url }) {
    const [text, setText] = useState(null);
    useEffect(() => {
        let alive = true;
        fetch(url).then((r) => r.text()).then((t) => { if (alive)
            setText(t.slice(0, 800)); }).catch(() => { if (alive)
            setText(null); });
        return () => { alive = false; };
    }, [url]);
    if (text == null)
        return _jsx("div", { className: "px-3 text-center text-step--2 text-[var(--faint)]", children: "Preview unavailable" });
    return _jsxs("pre", { className: "h-full w-full overflow-auto whitespace-pre-wrap break-words p-2 text-left text-[11px] leading-snug text-[var(--muted)]", children: [text || "(empty)", text.length >= 800 ? "\n…" : ""] });
}
export function GalleryView() {
    const [projects, setProjects] = useState([]);
    const [projectId, setProjectId] = useState("");
    const [q, setQ] = useState("");
    const [mime, setMime] = useState("");
    const [assets, setAssets] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const fileRef = useRef(null);
    useEffect(() => {
        api.listProjects().then((r) => {
            setProjects(r.projects || []);
            if (!projectId && r.projects?.[0]?.id)
                setProjectId(r.projects[0].id);
        }).catch(() => { });
    }, []);
    const load = async () => {
        if (!projectId) {
            setAssets([]);
            setTotal(0);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const res = await api.listGallery(projectId, { q: q || undefined, mime: mime || undefined, limit: 100 });
            setAssets(res.assets || []);
            setTotal(res.total || 0);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { void load(); }, [projectId, q, mime]);
    const upload = async (file) => {
        if (!projectId)
            return;
        setBusy(true);
        try {
            await api.uploadGalleryAsset(projectId, file, { source: file.name });
            toast.success("Asset uploaded");
            await load();
        }
        catch (e) {
            notifyError(e);
        }
        finally {
            setBusy(false);
        }
    };
    const token = getSession()?.token || "";
    return (_jsxs(Page, { children: [_jsx(PageHeader, { eyebrow: "Workspace", title: "Gallery", description: "Manage images and files for this workspace (view/manage only \u2014 no editing, OCR, or transcription). Upload policy: up to 10 MB per asset; stored per-project with metadata and safe previews/thumbnails where supported.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "primary", onClick: () => fileRef.current?.click(), disabled: !projectId || busy, children: "Upload file" }), _jsx("input", { ref: fileRef, type: "file", className: "hidden", "aria-label": "Upload gallery asset", onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f)
                                void upload(f); } })] }) }), _jsxs("div", { className: "mb-4 grid gap-2 sm:grid-cols-3", children: [_jsx(Field, { label: "Project", children: _jsxs("select", { className: FORM_SELECT, value: projectId, onChange: (e) => setProjectId(e.target.value), children: [_jsx("option", { value: "", children: "Select project" }), projects.map((p) => _jsx("option", { value: p.id, children: p.repository || p.id }, p.id))] }) }), _jsx(Field, { label: "Search", children: _jsx("input", { className: FORM_INPUT, value: q, onChange: (e) => setQ(e.target.value), placeholder: "Name or source" }) }), _jsx(Field, { label: "Type filter", children: _jsxs("select", { className: FORM_SELECT, value: mime, onChange: (e) => setMime(e.target.value), children: [_jsx("option", { value: "", children: "All types" }), _jsx("option", { value: "image/", children: "Images" }), _jsx("option", { value: "text/", children: "Text" }), _jsx("option", { value: "application/pdf", children: "PDF" })] }) })] }), loading ? _jsx(LoadingState, {}) : error ? _jsx(ErrorState, { error: error, onRetry: () => void load() }) : assets.length === 0 ? (_jsx(EmptyState, { title: "No assets", hint: "Upload images/files to manage and reference them in docs/chat." })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "mb-2 text-step--2 text-[var(--faint)]", children: [total, " assets"] }), _jsx("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3", children: assets.map((a) => {
                            const url = api.galleryAssetContentUrl(a.id, token);
                            return (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("div", { className: "mb-2 flex h-40 items-center justify-center overflow-hidden rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)]", children: isImage(a.mime_type) ? (_jsx("img", { src: url, alt: a.name, className: "max-h-full max-w-full object-contain", loading: "lazy" })) : isTextLike(a.mime_type, a.name) && (a.size || 0) <= 512 * 1024 ? (_jsx(TextPreview, { url: url, mime: a.mime_type })) : (_jsxs("div", { className: "px-3 text-center text-step--1 text-[var(--muted)]", children: [_jsx("div", { className: "mx-auto mb-1 flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--faint)]", "aria-hidden": true, children: "\uD83D\uDCC4" }), _jsx("div", { className: "font-medium text-[var(--text-soft)]", children: a.mime_type || "file" }), _jsx("div", { className: "mt-1 break-all text-step--2", children: a.name }), _jsx("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: "Safe preview unavailable for this type/size" })] })) }), _jsx("div", { className: "truncate font-medium text-[var(--text)]", title: a.name, children: a.name }), _jsxs("div", { className: "mt-1 flex flex-wrap gap-1.5 text-step--2 text-[var(--faint)]", children: [_jsx(Badge, { variant: "neutral", children: a.mime_type || "unknown" }), _jsx(Badge, { variant: "neutral", children: formatBytes(a.size || 0) }), a.metadata?.storage_policy ? _jsx(Badge, { variant: "neutral", children: String(a.metadata.storage_policy) }) : null] }), _jsxs("div", { className: "mt-1 text-step--2 text-[var(--faint)]", children: ["Source: ", a.source || "—", " \u00B7 ", a.id] }), (a.thread_id || a.task_id || a.doc_id) ? _jsxs("div", { className: "mt-0.5 text-step--2 text-[var(--faint)]", children: ["Linked: ", a.thread_id ? `thread ${a.thread_id} ` : "", a.task_id ? `task ${a.task_id} ` : "", a.doc_id ? `doc ${a.doc_id}` : ""] }) : null, _jsxs("div", { className: "mt-2 flex flex-wrap gap-2", children: [_jsx(Button, { onClick: () => window.open(url, "_blank"), children: "Preview" }), _jsx(Button, { onClick: () => { const ref = isImage(a.mime_type) ? `![${a.name}](${url})` : `[${a.name}](${url})`; navigator.clipboard?.writeText(ref); toast.success("Markdown reference copied"); }, children: "Copy md" }), _jsx(Button, { onClick: () => { navigator.clipboard?.writeText(url); toast.success("Link copied"); }, children: "Copy link" }), _jsx(Button, { onClick: () => { navigator.clipboard?.writeText(a.id); toast.success("Asset ID copied"); }, children: "Copy ID" }), _jsx(Button, { variant: "danger", onClick: async () => { if (!confirm(`Delete ${a.name}?`))
                                                    return; try {
                                                    await api.deleteGalleryAsset(a.id);
                                                    await load();
                                                }
                                                catch (e) {
                                                    notifyError(e);
                                                } }, children: "Delete" })] })] }, a.id));
                        }) })] }))] }));
}
