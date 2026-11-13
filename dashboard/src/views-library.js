import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, getSession } from "./api";
import { navigate, notifyError } from "./app";
import { Markdown } from "./markdown";
import { Badge, Button, EmptyState, ErrorState, Field, FORM_INPUT, FORM_SELECT, LoadingState, Modal, Page, PageHeader, PageSection, TABLE_SHELL, TABLE_TD, TABLE_TH, relativeTime, useAsync, } from "./components";
/* --- pure helpers (unit-tested) ------------------------------------------- */
export function filterLibraryDocs(rows, query) {
    const needle = query.trim().toLowerCase();
    if (!needle)
        return rows;
    return rows.filter(({ doc }) => [doc.title, doc.source, doc.content, doc.format || "", doc.kind || ""].some((value) => (value || "").toLowerCase().includes(needle)));
}
export function libraryProvenance(doc, mateName) {
    const writer = doc.teammate_id ? mateName(doc.teammate_id) : "you";
    return doc.tainted
        ? `Last written by ${writer} — bot-written, review before trusting`
        : `Last written by ${writer}`;
}
export function libraryKindLabel(kind) {
    if (kind === "upload")
        return "Upload";
    if (kind === "doc")
        return "Document";
    return "Note";
}
function sanitizeHtml(html) {
    // Simple sanitizer for preview: strip scripts/event handlers/javascript URLs.
    return (html || "")
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
        .replace(/on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(/(href|src)\s*=\s*("|\')\s*javascript:[^"']*(\2)/gi, '$1="#"')
        .replace(/<iframe[\s\S]*?>[\s\S]*?<\/iframe>/gi, "");
}
export function parseCsv(text) {
    const s = String(text ?? "");
    if (s === "")
        return [[""]];
    const rows = [];
    let row = [];
    let cell = "";
    let i = 0;
    let inQuotes = false;
    while (i < s.length) {
        const ch = s[i];
        if (inQuotes) {
            if (ch === '"' && s[i + 1] === '"') {
                cell += '"';
                i += 2;
                continue;
            }
            if (ch === '"') {
                inQuotes = false;
                i++;
                continue;
            }
            cell += ch;
            i++;
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === ",") {
            row.push(cell);
            cell = "";
            i++;
            continue;
        }
        if (ch === "\r") {
            i++;
            continue;
        }
        if (ch === "\n") {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
            i++;
            continue;
        }
        cell += ch;
        i++;
    }
    // RFC4180-like: trailing newline at EOF does not create an extra empty row.
    if (inQuotes) { /* unclosed quote: keep best-effort cell */ }
    const endedWithNewline = /\r?\n$/.test(s);
    const trailingEmpty = endedWithNewline && ((row.length === 1 && cell === "") || (row.length === 0 && cell === ""));
    if (!trailingEmpty) {
        row.push(cell);
        rows.push(row);
    }
    const maxCols = Math.max(1, ...rows.map((r) => r.length));
    return rows.map((r) => (r.length === maxCols ? r : [...r, ...Array(maxCols - r.length).fill("")]));
}
export function toCsv(rows) {
    const esc = (v) => {
        const s = String(v ?? "");
        if (/[",\n\r]/.test(s))
            return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    return (rows || []).map((r) => (r || []).map(esc).join(",")).join("\n");
}
function CsvGrid({ value, onChange, readOnly }) {
    const [rows, setRows] = useState(() => parseCsv(value || ""));
    useEffect(() => { setRows(parseCsv(value || "")); }, [value]);
    const update = (next) => {
        setRows(next);
        onChange?.(toCsv(next));
    };
    return (_jsxs("div", { className: "overflow-auto rounded-lg border border-[var(--border)]", children: [_jsx("table", { className: "min-w-full border-collapse text-step--1", children: _jsx("tbody", { children: rows.map((r, ri) => (_jsxs("tr", { children: [r.map((c, ci) => (_jsx("td", { className: "border border-[var(--border-dim)] p-0", children: _jsx("input", { className: "w-full min-w-[120px] bg-transparent px-2 py-1 outline-none", value: c, readOnly: readOnly, onChange: (e) => {
                                        const next = rows.map((row) => [...row]);
                                        next[ri][ci] = e.target.value;
                                        update(next);
                                    }, "aria-label": `Row ${ri + 1} column ${ci + 1}` }) }, ci))), !readOnly ? (_jsx("td", { className: "border border-[var(--border-dim)] px-1", children: _jsx("button", { type: "button", className: "text-[var(--danger)]", title: "Delete row", onClick: () => update(rows.filter((_, i) => i !== ri)), children: "\u00D7" }) })) : null] }, ri))) }) }), !readOnly ? (_jsxs("div", { className: "flex gap-2 border-t border-[var(--border-dim)] p-2", children: [_jsx(Button, { onClick: () => update([...rows, Array(Math.max(1, rows[0]?.length || 1)).fill("")]), children: "Add row" }), _jsx(Button, { onClick: () => update(rows.map((r) => [...r, ""])), children: "Add column" })] })) : null] }));
}
/* --- list ------------------------------------------------------------------ */
export function LibraryView() {
    const [query, setQuery] = useState("");
    const [formatFilter, setFormatFilter] = useState("");
    const [showNew, setShowNew] = useState(false);
    const [uploadFile, setUploadFile] = useState(null);
    const fileInputRef = useRef(null);
    const view = useAsync(async () => {
        const projects = await api.listProjects();
        const perProject = await Promise.all(projects.projects.map(async (project) => {
            try {
                const { docs } = await api.listLibrary(project.id);
                return docs.map((doc) => ({ doc, projectName: project.repository || "Untitled" }));
            }
            catch {
                return [];
            }
        }));
        return perProject.flat().sort((a, b) => (a.doc.updated_at < b.doc.updated_at ? 1 : -1));
    }, []);
    const rows = filterLibraryDocs(view.data ?? [], query).filter(({ doc }) => !formatFilter || (doc.format || "md") === formatFilter);
    return (_jsxs(Page, { children: [_jsx(PageHeader, { eyebrow: "Workspace", title: "Library", description: "Living documents and artifacts (markdown, HTML, CSV, text) with version history, exports, and AI-assisted editing.", actions: _jsxs(_Fragment, { children: [_jsx(Button, { variant: "primary", onClick: () => setShowNew(true), children: "New document" }), _jsx(Button, { onClick: () => fileInputRef.current?.click(), children: "Upload file" })] }) }), _jsx("input", { ref: fileInputRef, type: "file", accept: ".md,.txt,.markdown,.csv,.json,.yml,.yaml,.html,.htm,text/*", className: "hidden", "aria-label": "Upload a text file to the Library", onChange: (e) => {
                    const file = e.target.files?.[0] ?? null;
                    e.target.value = "";
                    if (file)
                        setUploadFile(file);
                } }), _jsxs("div", { className: "mb-3 flex flex-wrap gap-2", children: [_jsx("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Search documents", "aria-label": "Search documents", className: "h-9 w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-step--1 outline-none transition-colors placeholder:text-[var(--faint)] focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--ring)]" }), _jsxs("select", { className: FORM_SELECT, value: formatFilter, onChange: (e) => setFormatFilter(e.target.value), "aria-label": "Format filter", children: [_jsx("option", { value: "", children: "All formats" }), _jsx("option", { value: "md", children: "Markdown" }), _jsx("option", { value: "csv", children: "CSV" }), _jsx("option", { value: "html", children: "HTML" }), _jsx("option", { value: "text", children: "Text" })] })] }), view.loading ? (_jsx(LoadingState, {})) : view.error ? (_jsx(ErrorState, { error: view.error, onRetry: view.reload })) : rows.length === 0 ? (_jsx(EmptyState, { title: query || formatFilter ? "No documents match" : "No documents yet", hint: query || formatFilter ? "Try a different search/filter." : "Create a doc, upload a text file, or save content from chat/research.", action: !query && !formatFilter ? _jsx(Button, { variant: "primary", onClick: () => setShowNew(true), children: "New document" }) : null })) : (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full min-w-[700px] table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: `${TABLE_TH} w-[38%]`, children: "Document" }), _jsx("th", { className: `${TABLE_TH} w-[20%]`, children: "Project" }), _jsx("th", { className: `${TABLE_TH} w-[6rem]`, children: "Format" }), _jsx("th", { className: `${TABLE_TH} w-[7rem]`, children: "Kind" }), _jsx("th", { className: `${TABLE_TH} w-[9rem]`, children: "Updated" }), _jsx("th", { className: `${TABLE_TH} w-[6rem]`, children: _jsx("span", { className: "sr-only", children: "Open" }) })] }) }), _jsx("tbody", { children: rows.map(({ doc, projectName }) => (_jsxs("tr", { className: "transition-colors hover:bg-[var(--surface-2)]", children: [_jsx("td", { className: TABLE_TD, children: _jsxs("button", { className: "flex items-center gap-2 text-left text-[var(--text)] hover:underline", onClick: () => navigate(`/library/${doc.id}`), children: [_jsx("span", { className: "truncate", children: doc.title || "Untitled" }), doc.tainted ? _jsx(Badge, { variant: "warn", children: "bot-written" }) : null] }) }), _jsx("td", { className: `${TABLE_TD} truncate text-[var(--muted)]`, children: projectName }), _jsx("td", { className: TABLE_TD, children: _jsx(Badge, { variant: "neutral", children: (doc.format || "md").toUpperCase() }) }), _jsx("td", { className: TABLE_TD, children: _jsx(Badge, { variant: "neutral", children: libraryKindLabel(doc.kind) }) }), _jsx("td", { className: `${TABLE_TD} whitespace-nowrap text-[var(--faint)]`, children: relativeTime(doc.updated_at) }), _jsx("td", { className: `${TABLE_TD} whitespace-nowrap`, children: _jsx(Button, { variant: "ghost", onClick: () => navigate(`/library/${doc.id}`), children: "Open \u2192" }) })] }, doc.id))) })] }) })), showNew || uploadFile ? (_jsx(NewDocModal, { initialFile: uploadFile, onClose: () => { setShowNew(false); setUploadFile(null); } })) : null] }));
}
function NewDocModal({ initialFile, onClose }) {
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
        if (!chosen || busy)
            return;
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
            if (!title.trim())
                return;
            const doc = await api.createLibraryDoc(chosen, { title: title.trim(), content, kind: "note", format, source: "manual" });
            toast.success("Document created");
            onClose();
            navigate(`/library/${doc.id}`);
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx(Modal, { title: isUpload ? "Upload to Library" : "New document", onClose: onClose, children: _jsxs("form", { onSubmit: (e) => { e.preventDefault(); void submit(); }, className: "flex flex-col gap-1", children: [_jsx(Field, { label: "Project", children: _jsx("select", { value: chosen, onChange: (e) => setProjectId(e.target.value), className: FORM_SELECT, disabled: projects.loading, children: projectList.map((p) => _jsx("option", { value: p.id, children: p.repository || "Untitled" }, p.id)) }) }), _jsx(Field, { label: "Title", children: _jsx("input", { value: title, onChange: (e) => setTitle(e.target.value), placeholder: isUpload ? initialFile?.name : "Document title", className: FORM_INPUT, required: !isUpload }) }), isUpload ? (_jsxs("p", { className: "mb-3 text-step--1 text-[var(--muted)]", children: [initialFile?.name, " \u2014 text file, up to 1 MiB."] })) : (_jsxs(_Fragment, { children: [_jsx(Field, { label: "Format", children: _jsxs("select", { value: format, onChange: (e) => setFormat(e.target.value), className: FORM_SELECT, children: [_jsx("option", { value: "md", children: "Markdown" }), _jsx("option", { value: "csv", children: "CSV" }), _jsx("option", { value: "html", children: "HTML" }), _jsx("option", { value: "text", children: "Text" })] }) }), _jsx(Field, { label: "Content", children: _jsx("textarea", { value: content, onChange: (e) => setContent(e.target.value), rows: 8, placeholder: format === "csv" ? "a,b\n1,2" : "Start writing…", className: `${FORM_INPUT} resize-y` }) })] })), _jsxs("div", { className: "mt-1 flex justify-end gap-2", children: [_jsx(Button, { variant: "ghost", onClick: onClose, children: "Cancel" }), _jsx(Button, { type: "submit", variant: "primary", disabled: busy || !chosen, children: isUpload ? "Upload" : "Create" })] })] }) }));
}
/* --- detail ---------------------------------------------------------------- */
export function LibraryDocView({ docId }) {
    const doc = useAsync(() => api.getLibraryDoc(docId), [docId]);
    const versions = useAsync(() => api.listLibraryVersions(docId), [docId]);
    const access = useAsync(() => api.listLibraryAccess(docId), [docId]);
    const mates = useAsync(() => doc.data ? api.listTeammates(doc.data.project_id) : Promise.resolve({ teammates: [] }), [docId, doc.data?.project_id]);
    const [editing, setEditing] = useState(false);
    const [draftTitle, setDraftTitle] = useState("");
    const [draftContent, setDraftContent] = useState("");
    const [draftFormat, setDraftFormat] = useState("md");
    const [baseVersion, setBaseVersion] = useState(0);
    const [busy, setBusy] = useState(false);
    const [autosave, setAutosave] = useState("idle");
    const [grantMate, setGrantMate] = useState("");
    const [grantLevel, setGrantLevel] = useState("read");
    const [aiInstr, setAiInstr] = useState("");
    const [suggestion, setSuggestion] = useState(null);
    const [showPreview, setShowPreview] = useState(true);
    const [showRefPicker, setShowRefPicker] = useState(false);
    const [refTab, setRefTab] = useState("docs");
    const saveTimer = useRef(null);
    const contentRef = useRef(null);
    const token = getSession()?.token || "";
    const refProjectId = doc.data?.project_id || "";
    const refDocs = useAsync(() => refProjectId ? api.listLibrary(refProjectId) : Promise.resolve({ docs: [] }), [showRefPicker, refProjectId]);
    const refAssets = useAsync(() => refProjectId ? api.listGallery(refProjectId, { limit: 100 }) : Promise.resolve({ assets: [], total: 0 }), [showRefPicker, refProjectId]);
    const teammateList = mates.data?.teammates ?? [];
    const mateName = (teammateId) => {
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
    const doSave = async (opts) => {
        if (!doc.data)
            return;
        if (!opts?.silent)
            setBusy(true);
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
            if (!opts?.silent) {
                toast.success("Saved");
                setEditing(false);
            }
            await doc.reload();
            await versions.reload();
        }
        catch (err) {
            const conflict = err?.status === 409 || err?.detail?.conflict || (typeof err?.detail === "object" && err?.detail?.conflict);
            if (conflict) {
                setAutosave("conflict");
                if (!opts?.silent)
                    toast.error("Save conflict: document changed elsewhere. Reload and retry.");
            }
            else {
                setAutosave("error");
                if (!opts?.silent)
                    notifyError(err);
            }
        }
        finally {
            if (!opts?.silent)
                setBusy(false);
        }
    };
    useEffect(() => {
        if (!editing || !doc.data)
            return;
        if (saveTimer.current)
            window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => { void doSave({ silent: true, expected: baseVersion }); }, 1200);
        return () => { if (saveTimer.current)
            window.clearTimeout(saveTimer.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draftTitle, draftContent, draftFormat, editing]);
    const startEdit = () => {
        if (!doc.data)
            return;
        setDraftTitle(doc.data.title || "");
        setDraftContent(doc.data.content || "");
        setDraftFormat(doc.data.format || "md");
        setBaseVersion(doc.data.version || 1);
        setEditing(true);
        setAutosave("idle");
        setSuggestion(null);
    };
    const restore = async (version) => {
        if (!confirm(`Restore version ${version}? Current content becomes a new version.`))
            return;
        setBusy(true);
        try {
            await api.restoreLibraryVersion(docId, version);
            toast.success(`Version ${version} restored`);
            setEditing(false);
            setSuggestion(null);
            reloadAll();
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    const grant = async () => {
        if (!grantMate)
            return;
        try {
            await api.setLibraryAccess(docId, grantMate, grantLevel);
            setGrantMate("");
            access.reload();
            toast.success("Access updated");
        }
        catch (err) {
            notifyError(err);
        }
    };
    const revoke = async (teammateId) => {
        try {
            await api.revokeLibraryAccess(docId, teammateId);
            access.reload();
            toast.success("Access removed");
        }
        catch (err) {
            notifyError(err);
        }
    };
    const remove = async () => {
        if (!doc.data)
            return;
        if (!confirm(`Delete "${doc.data.title || "Untitled"}" and its entire history?`))
            return;
        try {
            await api.deleteLibraryDoc(docId);
            toast.success("Document deleted");
            navigate("/library");
        }
        catch (err) {
            notifyError(err);
        }
    };
    const askAi = async () => {
        if (!aiInstr.trim())
            return;
        setBusy(true);
        try {
            const res = await api.aiSuggestLibraryDoc(docId, aiInstr.trim());
            setSuggestion({ suggested_content: res.suggested_content, diff: res.diff, attribution: res.attribution });
            toast.success("Suggestion ready (not applied)");
        }
        catch (err) {
            notifyError(err);
        }
        finally {
            setBusy(false);
        }
    };
    if (doc.loading)
        return _jsx(Page, { children: _jsx(LoadingState, {}) });
    if (doc.error || !doc.data)
        return _jsx(Page, { children: _jsx(ErrorState, { error: doc.error ?? new Error("Document not found"), onRetry: doc.reload }) });
    const current = doc.data;
    const aclRows = access.data?.access ?? [];
    const grantedIds = new Set(aclRows.map((row) => row.teammate_id));
    const grantable = teammateList.filter((m) => !grantedIds.has(m.id));
    const exportUrl = (fmt) => api.exportLibraryDocUrl(docId, fmt, token);
    const docRefMd = `[${current.title || "Untitled"}](/library/${current.id})`;
    const docRefLink = `${(getSession()?.baseUrl || "").replace(/\/+$/, "")}/library/${current.id}`;
    const insertRef = (ref) => {
        const el = contentRef.current;
        if (el) {
            const start = el.selectionStart ?? draftContent.length;
            const end = el.selectionEnd ?? draftContent.length;
            const next = draftContent.slice(0, start) + ref + draftContent.slice(end);
            setDraftContent(next);
            requestAnimationFrame(() => { el.focus(); const pos = start + ref.length; el.setSelectionRange(pos, pos); });
        }
        else {
            setDraftContent((d) => d + (d && !d.endsWith("\n") ? "\n" : "") + ref);
        }
        setShowRefPicker(false);
    };
    return (_jsxs(Page, { width: "reading", children: [_jsx(PageHeader, { back: { label: "Library", onClick: () => navigate("/library") }, eyebrow: `${libraryKindLabel(current.kind)} · ${(current.format || "md").toUpperCase()}`, title: current.title || "Untitled", description: libraryProvenance(current, mateName), actions: editing ? (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", onClick: () => { setEditing(false); setSuggestion(null); setAutosave("idle"); }, disabled: busy, children: "Cancel" }), _jsx(Button, { variant: "primary", onClick: () => void doSave({ expected: baseVersion }), disabled: busy, children: "Save" })] })) : (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "primary", onClick: startEdit, children: "Edit" }), _jsx(Button, { variant: "danger", onClick: () => void remove(), children: "Delete" })] })) }), _jsxs("div", { className: "mb-4 flex flex-wrap items-center gap-2", children: [current.tainted ? _jsx(Badge, { variant: "warn", children: "bot-written" }) : null, _jsxs(Badge, { variant: "neutral", children: ["v", current.version] }), _jsx(Badge, { variant: "neutral", children: (current.format || "md").toUpperCase() }), current.source ? _jsxs("span", { className: "text-step--2 text-[var(--faint)]", children: ["source: ", current.source] }) : null, _jsxs("span", { className: "text-step--2 text-[var(--faint)]", children: ["updated ", relativeTime(current.updated_at)] }), editing ? _jsxs("span", { className: "text-step--2 text-[var(--faint)]", children: ["autosave: ", autosave, autosave === "conflict" ? " (reload to resolve)" : ""] }) : null] }), _jsxs("div", { className: "mb-4 flex flex-wrap gap-2", children: [_jsx("a", { className: "inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 hover:bg-[var(--surface-2)]", href: exportUrl("md"), target: "_blank", rel: "noreferrer", children: "Export .md" }), _jsx("a", { className: "inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 hover:bg-[var(--surface-2)]", href: exportUrl("csv"), target: "_blank", rel: "noreferrer", children: "Export .csv" }), _jsx("a", { className: "inline-flex items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-step--1 hover:bg-[var(--surface-2)]", href: exportUrl("html"), target: "_blank", rel: "noreferrer", children: "Export .html" }), _jsx(Button, { onClick: () => { navigator.clipboard?.writeText(docRefMd); toast.success("Document reference copied"); }, children: "Copy ref" }), _jsx(Button, { onClick: () => { navigator.clipboard?.writeText(docRefLink); toast.success("Document link copied"); }, children: "Copy link" }), _jsx(Button, { onClick: () => { navigator.clipboard?.writeText(current.id); toast.success("Document ID copied"); }, children: "Copy ID" }), editing ? _jsx(Button, { onClick: () => setShowRefPicker(true), children: "Insert ref" }) : null, (current.thread_id || current.task_id || current.job_id) ? (_jsxs("span", { className: "text-step--2 text-[var(--faint)] self-center", children: ["Linked: ", current.thread_id ? `thread ${current.thread_id} ` : "", current.task_id ? `task ${current.task_id} ` : "", current.job_id ? `job ${current.job_id}` : ""] })) : null] }), editing ? (_jsxs("div", { className: "flex flex-col gap-3", children: [_jsxs("div", { className: "grid gap-2 sm:grid-cols-2", children: [_jsx(Field, { label: "Title", children: _jsx("input", { value: draftTitle, onChange: (e) => setDraftTitle(e.target.value), className: FORM_INPUT }) }), _jsx(Field, { label: "Format", children: _jsxs("select", { value: draftFormat, onChange: (e) => setDraftFormat(e.target.value), className: FORM_SELECT, children: [_jsx("option", { value: "md", children: "Markdown" }), _jsx("option", { value: "csv", children: "CSV" }), _jsx("option", { value: "html", children: "HTML" }), _jsx("option", { value: "text", children: "Text" })] }) })] }), draftFormat === "csv" ? (_jsx(Field, { label: "Content (CSV grid)", children: _jsx(CsvGrid, { value: draftContent, onChange: setDraftContent }) })) : (_jsxs("div", { className: "space-y-2", children: [draftFormat === "md" ? (_jsxs("div", { className: "flex flex-wrap gap-1.5 rounded-lg border border-[var(--border-dim)] bg-[var(--surface-2)] p-2", children: [[
                                        { label: "B", title: "Bold", pre: "**", post: "**", placeholder: "bold" },
                                        { label: "I", title: "Italic", pre: "_", post: "_", placeholder: "italic" },
                                        { label: "H2", title: "Heading", pre: "\n## ", post: "\n", placeholder: "Heading" },
                                        { label: "List", title: "Bullet list", pre: "\n- ", post: "", placeholder: "item" },
                                        { label: "Quote", title: "Quote", pre: "\n> ", post: "", placeholder: "quote" },
                                        { label: "Code", title: "Inline code", pre: "`", post: "`", placeholder: "code" },
                                        { label: "Link", title: "Link", pre: "[", post: "](url)", placeholder: "text" },
                                    ].map((b) => (_jsx("button", { type: "button", className: "rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-step--2 hover:bg-[var(--surface-3,var(--surface))]", title: b.title, onClick: () => {
                                            const el = contentRef.current;
                                            if (!el)
                                                return;
                                            const start = el.selectionStart ?? draftContent.length;
                                            const end = el.selectionEnd ?? draftContent.length;
                                            const selected = draftContent.slice(start, end) || b.placeholder;
                                            const next = draftContent.slice(0, start) + b.pre + selected + b.post + draftContent.slice(end);
                                            setDraftContent(next);
                                            requestAnimationFrame(() => { el.focus(); const pos = start + b.pre.length + selected.length; el.setSelectionRange(pos, pos); });
                                        }, children: b.label }, b.label))), _jsx("button", { type: "button", className: "rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-step--2 hover:bg-[var(--surface-3,var(--surface))]", title: "Insert Library/Gallery reference", onClick: () => setShowRefPicker(true), children: "+ Ref" }), _jsxs("label", { className: "ml-auto inline-flex items-center gap-1.5 text-step--2 text-[var(--muted)]", children: [_jsx("input", { type: "checkbox", checked: showPreview, onChange: (e) => setShowPreview(e.target.checked) }), " Preview"] })] })) : draftFormat === "html" || draftFormat === "text" ? (_jsx("div", { className: "flex flex-wrap gap-1.5", children: _jsx("button", { type: "button", className: "rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-step--2", onClick: () => setShowRefPicker(true), children: "Insert reference" }) })) : null, _jsx(Field, { label: `Content${draftFormat === "md" ? " (Markdown)" : draftFormat === "html" ? " (HTML)" : " (Text)"}`, children: _jsx("textarea", { ref: contentRef, value: draftContent, onChange: (e) => setDraftContent(e.target.value), rows: 18, className: `${FORM_INPUT} resize-y font-mono` }) }), draftFormat === "md" && showPreview ? (_jsxs("div", { children: [_jsx("div", { className: "mb-1 text-step--2 font-medium text-[var(--muted)]", children: "Live preview" }), _jsx("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3", children: _jsx(Markdown, { text: draftContent || "" }) })] })) : null] })), draftFormat === "html" ? (_jsxs("div", { children: [_jsx("div", { className: "mb-1 text-step--2 font-medium text-[var(--muted)]", children: "Sanitized preview" }), _jsx("div", { className: "rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 prose prose-sm max-w-none", dangerouslySetInnerHTML: { __html: sanitizeHtml(draftContent) } })] })) : null, _jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsx("div", { className: "mb-2 text-step--1 font-medium text-[var(--text)]", children: "Ask AI (suggested revision \u2014 not applied automatically)" }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsx("input", { className: `${FORM_INPUT} min-w-[260px] flex-1`, value: aiInstr, onChange: (e) => setAiInstr(e.target.value), placeholder: "e.g. tighten intro, fix tone, summarize, convert to table..." }), _jsx(Button, { onClick: () => void askAi(), disabled: busy || !aiInstr.trim(), children: "Generate suggestion" })] }), suggestion ? (_jsxs("div", { className: "mt-3 space-y-2", children: [_jsxs("div", { className: "text-step--2 text-[var(--muted)]", children: ["Attribution: ", suggestion.attribution?.actor_type || "assistant", " ", suggestion.attribution?.actor || "", ". Review before applying."] }), suggestion.diff ? _jsx("pre", { className: "max-h-56 overflow-auto rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] p-2 text-step--2 whitespace-pre-wrap", children: suggestion.diff }) : null, _jsxs("details", { className: "rounded-md border border-[var(--border-dim)] bg-[var(--surface-2)] p-2", children: [_jsx("summary", { className: "cursor-pointer text-step--2 font-medium", children: "Suggested content preview" }), _jsx("pre", { className: "mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-step--2", children: suggestion.suggested_content })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { variant: "primary", onClick: () => { setDraftContent(suggestion.suggested_content); setSuggestion(null); toast.success("Suggestion applied to draft (save to persist)"); }, children: "Accept/apply to draft" }), _jsx(Button, { onClick: () => setSuggestion(null), children: "Reject" })] })] })) : null] })] })) : (_jsx("div", { className: "space-y-4", children: (current.format || "md") === "csv" ? (_jsx(CsvGrid, { value: current.content || "", readOnly: true })) : (current.format || "md") === "html" ? (_jsx("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4", children: _jsx("div", { className: "prose prose-sm max-w-none", dangerouslySetInnerHTML: { __html: sanitizeHtml(current.content || "") } }) })) : (_jsx("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4", children: current.content ? _jsx(Markdown, { text: current.content }) : _jsx("p", { className: "text-step--1 text-[var(--faint)]", children: "This document is empty." }) })) })), _jsx("div", { className: "mt-10", children: _jsx(PageSection, { title: "Version history", description: "Every save is kept. Restoring adds a new version instead of erasing one.", children: versions.loading ? _jsx(LoadingState, { lines: 2 }) : versions.error ? _jsx(ErrorState, { error: versions.error, onRetry: versions.reload }) : (versions.data?.versions.length ?? 0) === 0 ? (_jsx(EmptyState, { title: "No versions yet", hint: "" })) : (_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full min-w-[560px] table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: `${TABLE_TH} w-[6rem]`, children: "Version" }), _jsx("th", { className: TABLE_TH, children: "When" }), _jsx("th", { className: TABLE_TH, children: "Writer" }), _jsx("th", { className: `${TABLE_TH} w-[8rem]`, children: _jsx("span", { className: "sr-only", children: "Restore" }) })] }) }), _jsx("tbody", { children: [...(versions.data?.versions ?? [])].reverse().map((v) => (_jsxs("tr", { children: [_jsxs("td", { className: TABLE_TD, children: ["v", v.version, v.version === current.version ? _jsx("span", { className: "ml-1 text-[var(--faint)]", children: "(current)" }) : null] }), _jsx("td", { className: `${TABLE_TD} text-[var(--faint)]`, children: relativeTime(v.created_at) }), _jsxs("td", { className: TABLE_TD, children: [v.teammate_id ? mateName(v.teammate_id) : "you", v.tainted ? " · bot-written" : ""] }), _jsx("td", { className: TABLE_TD, children: v.version === current.version ? null : _jsx(Button, { variant: "ghost", onClick: () => void restore(v.version), disabled: busy, children: "Restore" }) })] }, v.id))) })] }) })) }) }), showRefPicker ? (_jsxs(Modal, { title: "Insert reference", onClose: () => setShowRefPicker(false), children: [_jsxs("div", { className: "mb-3 flex gap-2", children: [_jsx(Button, { variant: refTab === "docs" ? "primary" : "ghost", onClick: () => setRefTab("docs"), children: "Library docs" }), _jsx(Button, { variant: refTab === "gallery" ? "primary" : "ghost", onClick: () => setRefTab("gallery"), children: "Gallery assets" })] }), refTab === "docs" ? (refDocs.loading ? _jsx(LoadingState, { lines: 2 }) : refDocs.error ? _jsx(ErrorState, { error: refDocs.error, onRetry: refDocs.reload }) : (refDocs.data?.docs || []).length === 0 ? _jsx(EmptyState, { title: "No documents", hint: "" }) : (_jsx("div", { className: "flex max-h-80 flex-col gap-1 overflow-auto", children: (refDocs.data?.docs || []).filter((d) => d.id !== current.id).map((d) => (_jsxs("button", { type: "button", className: "rounded-md border border-[var(--border-dim)] px-2.5 py-2 text-left hover:bg-[var(--surface-2)]", onClick: () => insertRef(`[${d.title || "Untitled"}](/library/${d.id})`), children: [_jsx("div", { className: "truncate text-step--1", children: d.title || "Untitled" }), _jsxs("div", { className: "text-step--2 text-[var(--faint)]", children: [(d.format || "md").toUpperCase(), " \u00B7 ", d.id] })] }, d.id))) }))) : (refAssets.loading ? _jsx(LoadingState, { lines: 2 }) : refAssets.error ? _jsx(ErrorState, { error: refAssets.error, onRetry: refAssets.reload }) : (refAssets.data?.assets || []).length === 0 ? _jsx(EmptyState, { title: "No assets", hint: "" }) : (_jsx("div", { className: "flex max-h-80 flex-col gap-1 overflow-auto", children: (refAssets.data?.assets || []).map((a) => {
                            const url = api.galleryAssetContentUrl(a.id, token);
                            const ref = (a.mime_type || "").startsWith("image/") ? `![${a.name || "asset"}](${url})` : `[${a.name || "asset"}](${url})`;
                            return (_jsxs("button", { type: "button", className: "rounded-md border border-[var(--border-dim)] px-2.5 py-2 text-left hover:bg-[var(--surface-2)]", onClick: () => insertRef(ref), children: [_jsx("div", { className: "truncate text-step--1", children: a.name || "Asset" }), _jsxs("div", { className: "text-step--2 text-[var(--faint)]", children: [a.mime_type || "file", " \u00B7 ", a.id] })] }, a.id));
                        }) })))] })) : null, _jsx("div", { className: "mt-10", children: _jsx(PageSection, { title: "Access", description: "Who can read or edit this document. Owner manages access; a missing row means no access.", children: access.loading ? _jsx(LoadingState, { lines: 2 }) : access.error ? _jsx(ErrorState, { error: access.error, onRetry: access.reload }) : (_jsxs(_Fragment, { children: [_jsx("div", { className: TABLE_SHELL, children: _jsxs("table", { className: "w-full min-w-[520px] table-fixed", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { className: TABLE_TH, children: "Teammate" }), _jsx("th", { className: `${TABLE_TH} w-[8rem]`, children: "Access" }), _jsx("th", { className: `${TABLE_TH} w-[8rem]`, children: _jsx("span", { className: "sr-only", children: "Revoke" }) })] }) }), _jsx("tbody", { children: aclRows.length === 0 ? (_jsx("tr", { children: _jsx("td", { className: `${TABLE_TD} text-[var(--faint)]`, colSpan: 3, children: "No teammate has access yet." }) })) : aclRows.map((row) => (_jsxs("tr", { children: [_jsx("td", { className: TABLE_TD, children: mateName(row.teammate_id) }), _jsx("td", { className: TABLE_TD, children: _jsx(Badge, { variant: row.access === "write" ? "ok" : "neutral", children: row.access }) }), _jsx("td", { className: TABLE_TD, children: _jsx(Button, { variant: "ghost", onClick: () => void revoke(row.teammate_id), children: "Remove" }) })] }, row.id))) })] }) }), _jsxs("div", { className: "mt-3 flex flex-wrap items-end gap-2", children: [_jsx(Field, { label: "Teammate", children: _jsxs("select", { value: grantMate, onChange: (e) => setGrantMate(e.target.value), className: FORM_SELECT, children: [_jsx("option", { value: "", children: "Choose a teammate" }), grantable.map((m) => _jsx("option", { value: m.id, children: m.name || m.slug || m.id }, m.id))] }) }), _jsx(Field, { label: "Access", children: _jsxs("select", { value: grantLevel, onChange: (e) => setGrantLevel(e.target.value), className: FORM_SELECT, children: [_jsx("option", { value: "read", children: "Read" }), _jsx("option", { value: "write", children: "Write" })] }) }), _jsx("div", { className: "pb-3", children: _jsx(Button, { variant: "primary", onClick: () => void grant(), disabled: !grantMate, children: "Grant access" }) })] })] })) }) })] }));
}
