import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { api } from "../api";
import { notifyError } from "../app";
import { Badge, Button, EmptyState, ErrorState, FORM_INPUT, FORM_SELECT, LoadingState, Modal, useAsync, } from "../components";
import { EntityForm } from "../forms";
export function MemoryTab({ projectId }) {
    const [q, setQ] = useState("");
    const [tier, setTier] = useState("");
    const [pinnedOnly, setPinnedOnly] = useState(false);
    const [page, setPage] = useState(0);
    const limit = 30;
    const list = useAsync(() => api.projectMemory(projectId, { q: q || undefined, tier: tier || undefined, pinned: pinnedOnly || undefined, limit, offset: page * limit }), [projectId, q, tier, pinnedOnly, page]);
    const [showWrite, setShowWrite] = useState(false);
    const [edit, setEdit] = useState(null);
    useEffect(() => { setPage(0); }, [q, tier, pinnedOnly]);
    const act = async (fn) => {
        try {
            await fn();
            list.reload();
        }
        catch (err) {
            notifyError(err);
        }
    };
    const entries = list.data?.entries ?? [];
    const total = list.data?.total ?? entries.length;
    return (_jsxs("div", { children: [_jsxs("div", { className: "mb-3 flex flex-wrap items-center gap-2", children: [_jsx(Button, { variant: "primary", onClick: () => setShowWrite(true), children: "Remember something" }), _jsx(Button, { onClick: list.reload, children: "Refresh" }), _jsx(Button, { variant: "ghost", onClick: () => void act(() => api.pruneMemory(`project:${projectId}`, { keep: 500 })), children: "Retention prune" }), _jsx("input", { className: `${FORM_INPUT} max-w-xs`, placeholder: "Search memories", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search memories" }), _jsxs("select", { className: FORM_SELECT, value: tier, onChange: (e) => setTier(e.target.value), "aria-label": "Tier filter", children: [_jsx("option", { value: "", children: "All tiers" }), _jsx("option", { value: "raw", children: "raw" }), _jsx("option", { value: "typed", children: "typed" }), _jsx("option", { value: "wisdom", children: "wisdom" })] }), _jsxs("label", { className: "flex items-center gap-1.5 text-step--1 text-[var(--muted)]", children: [_jsx("input", { type: "checkbox", checked: pinnedOnly, onChange: (e) => setPinnedOnly(e.target.checked) }), " Pinned"] })] }), _jsx("p", { className: "mb-3 text-step--1 text-[var(--muted)]", children: "What this workspace remembers, with source/provenance. Memories are scoped and fail-closed. When chat uses memories, it treats them as untrusted context." }), showWrite ? (_jsx(Modal, { title: "Add memory", onClose: () => setShowWrite(false), children: _jsx(EntityForm, { submitLabel: "Save", fields: [
                        { name: "content", label: "What to remember", required: true, type: "textarea" },
                        { name: "source", label: "Source/provenance", required: true, placeholder: "e.g. user note, chat summary" },
                        { name: "confidence", label: "Confidence (0–1)", placeholder: "0.8" },
                        { name: "tier", label: "Tier", placeholder: "raw|typed|wisdom" },
                    ], onSubmit: async (values) => {
                        await api.writeProjectMemory(projectId, {
                            content: values.content,
                            source: values.source,
                            confidence: Number(values.confidence || 0.8),
                            tier: values.tier || "raw",
                            provenance: { kind: "manual", actor: "user" },
                        });
                        setShowWrite(false);
                        list.reload();
                    } }) })) : null, edit ? (_jsx(Modal, { title: "Edit memory", onClose: () => setEdit(null), children: _jsxs("form", { className: "flex flex-col gap-3", onSubmit: async (e) => { e.preventDefault(); try {
                        await api.patchMemory(edit.id, { content: e.currentTarget.content.value, source: e.currentTarget.source.value });
                        setEdit(null);
                        list.reload();
                    }
                    catch (err) {
                        notifyError(err);
                    } }, children: [_jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Content" }), _jsx("textarea", { name: "content", className: `${FORM_INPUT} min-h-24`, defaultValue: edit.content })] }), _jsxs("label", { className: "text-step--1", children: [_jsx("div", { className: "mb-1 font-medium", children: "Source" }), _jsx("input", { name: "source", className: FORM_INPUT, defaultValue: edit.source })] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx(Button, { type: "button", onClick: () => setEdit(null), children: "Cancel" }), _jsx(Button, { variant: "primary", type: "submit", children: "Save correction" })] })] }) })) : null, list.loading ? _jsx(LoadingState, {}) : list.error ? _jsx(ErrorState, { error: list.error, onRetry: list.reload }) : entries.length === 0 ? (_jsx(EmptyState, { title: "No memories yet", hint: "Add a note, or let the workspace accumulate scoped memories. Search, pin important facts, correct mistakes, or delete entries here." })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "flex flex-col gap-2", children: entries.map((entry) => (_jsxs("div", { className: "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3", children: [_jsxs("div", { className: "flex flex-wrap items-start justify-between gap-2", children: [_jsx("div", { className: "min-w-0 flex-1 whitespace-pre-wrap text-step--1 text-[var(--text-soft)]", children: entry.content }), _jsxs("div", { className: "flex shrink-0 flex-wrap gap-1.5", children: [entry.pinned ? _jsx(Badge, { variant: "info", children: "pinned" }) : null, entry.corrected ? _jsx(Badge, { variant: "warn", children: "corrected" }) : null, _jsx(Badge, { variant: "neutral", children: entry.tier || "raw" })] })] }), _jsxs("div", { className: "mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-step--2 text-[var(--faint)]", children: [_jsxs("span", { children: ["Source: ", _jsx("span", { className: "text-[var(--muted)]", children: entry.source || "unknown" })] }), _jsxs("span", { children: ["Confidence: ", typeof entry.confidence === "number" ? entry.confidence.toFixed(2) : entry.confidence] }), _jsxs("span", { children: ["Scope: ", _jsx("span", { className: "mono", children: entry.scope })] }), _jsx("span", { className: "mono", children: entry.id })] }), _jsxs("div", { className: "mt-2 flex flex-wrap gap-2", children: [_jsx(Button, { onClick: () => void act(() => api.patchMemory(entry.id, { pinned: !entry.pinned })), children: entry.pinned ? "Unpin" : "Pin" }), _jsx(Button, { onClick: () => setEdit(entry), children: "Correct" }), _jsx(Button, { variant: "danger", onClick: () => { if (confirm("Delete this memory?"))
                                                void act(() => api.deleteMemory(entry.id)); }, children: "Delete" })] })] }, entry.id))) }), _jsxs("div", { className: "mt-3 flex items-center justify-between text-step--2 text-[var(--muted)]", children: [_jsxs("span", { children: [total, " total"] }), _jsxs("div", { className: "flex gap-2", children: [_jsx(Button, { disabled: page === 0, onClick: () => setPage((p) => Math.max(0, p - 1)), children: "Prev" }), _jsx(Button, { disabled: (page + 1) * limit >= total, onClick: () => setPage((p) => p + 1), children: "Next" })] })] })] }))] }));
}
